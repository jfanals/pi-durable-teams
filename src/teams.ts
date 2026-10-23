// Adapted from Pi Durable example 23 at 73f8de80bc87021375f8b525292ac07492253002.
// The root is a non-model control conversation, NOT a mirrored interactive main.
import { realpath, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry, configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool,
  Harness, watchEvents,
  type AgentChange, type ConversationId, type EntryId, type HarnessOptions, type ModelRef,
  type Storage, type TaskId, type Tx,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ActionSchema, TOOL_DESCRIPTION, TOOL_NAME, type Action, type Actor, type Delivery, type Mode } from "./protocol.ts";

const context = BACKGROUND_CONTEXT;
type Worker = { actor: Actor; conversationId: ConversationId; enabled: boolean };
export type MainRegistration = {
  sessionId: string; secret: string; name: string; cwd: string;
  model: ModelRef; thinking?: AgentChange["thinkingLevel"]; latest?: string;
};
type Team = {
  main: MainRegistration; paused: boolean; workers: Record<string, Worker>;
  pending: Record<string, Delivery>;
};
export const Teams = defineDoc<{
  teams: Record<string, Team>;
  requests: Record<string, { taskId?: TaskId; delivery?: string; workerId?: string }>;
  reported: Record<string, boolean>;
}>({
  kind: "teams.registry", version: 1, scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ teams: {}, requests: {}, reported: {} }),
});

const mainActor = (teamId: string, team: Team): Actor => ({ id: teamId, teamId, role: "main", name: team.main.name });
const textOf = (message?: AssistantMessage) =>
  message?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
const terminal = () => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const;
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "teams.anchor", version: 1, initial: () => ({ phase: "done" }),
  phases: { done: (_task, runtime, ctx) => runtime.commit(terminal, ctx) },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

type ReporterInput = { from: Actor; worker: Worker; message: string; mode: Mode };
type ReporterState = { phase: "deliver" } | { phase: "report"; text?: string; answer?: EntryId };
type ReporterResult = { answer?: EntryId; status: string };

export type TeamsOptions = Omit<HarnessOptions, "registry"> & {
  registry?: ReturnType<typeof createRegistry>;
  validateModel?: (model: ModelRef) => void;
  /** Host-wide worker model; when unset, workers use the main's current model. */
  workerModel?: ModelRef;
  /** Per-name worker models: key "review" matches any worker whose name contains it (case-insensitive). */
  workerModels?: Record<string, ModelRef>;
  workerAgent?: (cwd: string) => Promise<AgentChange>;
};

export async function openTeams(storage: Storage, options: TeamsOptions) {
  let harness: Harness;
  const registry = options.registry ?? createRegistry();
  const changed = new Set<() => void>();
  const notify = () => { for (const listener of changed) listener(); };
  const read = async () => (await harness.snapshot(Teams, context)) ?? { teams: {}, requests: {}, reported: {} };
  const root = () => harness.root(context);

  function findWorker(state: Awaited<ReturnType<typeof read>>, id: string): Worker | undefined {
    for (const team of Object.values(state.teams)) {
      const found = Object.values(team.workers).find(worker => worker.actor.id === id || String(worker.conversationId) === id);
      if (found) return found;
    }
  }
  function resolveTarget(state: Awaited<ReturnType<typeof read>>, actor: Actor, target = "main"): Actor {
    const own = state.teams[actor.teamId];
    if (!own) throw new Error("Unknown team");
    if (target === "main" || target === actor.teamId) return mainActor(actor.teamId, own);
    const worker = Object.values(own.workers).find(w => w.actor.id === target || w.actor.name === target);
    if (worker) return worker.actor;
    if (actor.role === "main" && state.teams[target]) return mainActor(target, state.teams[target]);
    throw new Error("No accessible agent with that ID/name");
  }
  async function enqueue(tx: Tx, recipient: Actor, delivery: Delivery) {
    const doc = await tx.doc(Teams);
    const team = doc.teams[recipient.teamId];
    if (!team) throw new Error("Unknown destination team");
    if (delivery.from.role === "worker" && (!findWorker(doc, delivery.from.id)?.enabled || doc.teams[delivery.from.teamId]?.paused)) return;
    team.pending[delivery.id] ??= delivery;
  }

  const Reporter = defineTask<ReporterInput, ReporterState, ReporterResult>({
    name: "teams.reporter", version: 1, initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const { worker, from, message, mode } = task.input;
        const state = await runtime.snapshot(Teams, ctx);
        const current = state && findWorker(state, worker.actor.id);
        if (!current?.enabled || state?.teams[worker.actor.teamId]?.paused) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "stopped" } } }), ctx);
          return;
        }
        const child = (await runtime.conversation(worker.conversationId, ctx))!;
        const submission = await child.submit({
          type: "input", content: `[${from.name} (${from.id})]: ${message}`, whenBusy: mode,
          requestId: `teams-input:${task.id}`,
          entry: { kind: "teams.message", data: { from, message } },
        }, ctx);
        const settled = await submission.wait(ctx);
        await runtime.commit(async tx => {
          if (settled.status !== "done" || settled.type !== "input") {
            return { status: "running", checkpoint: { phase: "report", text: `[${worker.actor.name}: unanswered (${settled.status === "unanswered" ? settled.reason : settled.status})]` } } as const;
          }
          const doc = await tx.doc(Teams);
          const receipt = `${from.id}:${worker.actor.id}:${settled.answer}`;
          if (doc.reported[receipt]) return { status: "running", checkpoint: { phase: "report", answer: settled.answer } } as const;
          doc.reported[receipt] = true;
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
          return { status: "running", checkpoint: { phase: "report", text: textOf(answer), answer: settled.answer } } as const;
        }, ctx);
      },
      report: async (task, runtime, ctx) => {
        const checkpoint = task.state.checkpoint;
        if (checkpoint.phase !== "report") return;
        const { from, worker } = task.input;
        const state = await runtime.snapshot(Teams, ctx);
        const enabled = state && findWorker(state, worker.actor.id)?.enabled && !state.teams[worker.actor.teamId]?.paused;
        const id = `teams-report:${task.id}`;
        if (checkpoint.text !== undefined && enabled) {
          if (from.role === "main") {
            await runtime.commit(async tx => {
              await enqueue(tx, from, {
                id, from: worker.actor, text: checkpoint.text!, mode: "followUp", request: String(task.id),
              });
              return undefined;
            }, ctx);
            notify();
          } else {
            const recipient = state && findWorker(state, from.id);
            if (recipient?.enabled && !state?.teams[from.teamId]?.paused) {
              await (await runtime.conversation(recipient.conversationId, ctx))!.submit({
                type: "input", content: `[${worker.actor.name} report; no acknowledgement needed]: ${checkpoint.text}`,
                requestId: id, whenBusy: "followUp",
                entry: { kind: "teams.report", data: { from: worker.actor, request: task.id } },
              }, ctx);
            }
          }
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {
          status: enabled ? "reported" : "stopped", ...(checkpoint.answer === undefined ? {} : { answer: checkpoint.answer }),
        } } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });

  async function action(actor: Actor, args: Action, requestId: string) {
    const state = await read();
    const team = state.teams[actor.teamId];
    if (!team) throw new Error("Unknown team");
    if (args.action === "list") {
      if (args.scope === "mains") {
        if (actor.role !== "main") throw new Error("Only mains can discover other teams");
        return Object.entries(state.teams).map(([id, value]) => ({ ...mainActor(id, value), paused: value.paused }));
      }
      return [mainActor(actor.teamId, team), ...Object.values(team.workers).map(w => ({ ...w.actor, enabled: w.enabled }))];
    }
    const target = args.action === "spawn" ? undefined : resolveTarget(state, actor, args.target);
    if (args.action === "inspect") {
      if (args.request) {
        const task = await harness.getTask(Number(args.request) as TaskId, context);
        if (!task || task.kind !== "teams.reporter" || (task.input as ReporterInput).from.id !== actor.id) throw new Error("Unknown request for this agent");
        const input = task.input as ReporterInput;
        const conversation = (await harness.conversation(input.worker.conversationId, context))!;
        const submissionId = `teams-input:${task.id}`;
        // Task outcome identifies the answer; never mistake an intermediate assistant message for completion.
        const outcome = task.state.status === "terminal" ? task.state.outcome : undefined;
        const result = outcome?.status === "completed" ? outcome.result as ReporterResult : undefined;
        const answer = result?.answer === undefined ? undefined : await conversation.commit(tx => tx.entry(AssistantEntry, result.answer!), context);
        return { request: task.id, state: task.state, submissionKey: submissionId, answer: answer?.model?.[0] };
      }
      if (target!.role === "main") return { ...target, latest: state.teams[target!.teamId]!.main.latest, observed: "last main publication; may be stale/offline" };
      const worker = findWorker(state, target!.id)!;
      const conversation = (await harness.conversation(worker.conversationId, context))!;
      if (args.transcript) {
        const page = await conversation.entries({}, 40, args.cursor ? JSON.parse(args.cursor) : undefined, context);
        return { ...target, entries: page.items, next: page.next ? JSON.stringify(page.next) : undefined };
      }
      const v = await conversation.viewState(context);
      try {
        const messages = v.value.entries.flatMap(entry => entry.model ?? []);
        const latest = messages.findLast(m => m.role === "assistant");
        // When the newest input arrived: the start of the current (or last) request, for elapsed time.
        const since = (messages.findLast(m => m.role === "user") as { timestamp?: number } | undefined)?.timestamp;
        // pi.agent holds the worker's configured model, thinking level and cwd.
        const agent = v.value.docs["pi.agent"] as { model?: ModelRef } | undefined;
        let contextWindow: number | undefined;
        try { contextWindow = agent?.model && options.models?.getModel(agent.model.provider, agent.model.modelId)?.contextWindow; } catch { /* provider not allowed or unknown */ }
        return { ...target, enabled: worker.enabled, agent, contextWindow, live: v.value.docs["pi.live"], usage: v.value.docs["pi.usage"], latest, since };
      } finally { v.dispose(); }
    }
    if (actor.role === "worker" && args.action !== "send") throw new Error("Workers cannot spawn or stop agents");
    if (team.paused) throw new Error("Team paused. The human must use /team resume before starting more work.");
    if (!requestId) throw new Error("A stable request ID is required");
    const requestKey = `${actor.id}:${requestId}`;
    if (state.requests[requestKey]) return state.requests[requestKey];

    if (args.action === "stop") {
      if (!args.team && target!.role !== "worker") throw new Error("Stop a worker, or explicitly stop your own team");
      const workers = args.team ? Object.values(team.workers) : [findWorker(state, target!.id)!];
      await harness.commit(async tx => {
        const doc = await tx.doc(Teams);
        if (args.team) doc.teams[actor.teamId]!.paused = true;
        for (const worker of workers) doc.teams[actor.teamId]!.workers[worker.actor.name]!.enabled = false;
        for (const [id, pending] of Object.entries(doc.teams[actor.teamId]!.pending)) {
          if (workers.some(worker => worker.actor.id === pending.from.id)) delete doc.teams[actor.teamId]!.pending[id];
        }
      }, context);
      // Stop reporters before their child input can be admitted after the worker abort.
      const inspection = await harness.inspect(context);
      for (const { record: task } of inspection.tasks) {
        if (task.kind === "teams.reporter" && workers.some(worker => worker.actor.id === (task.input as ReporterInput).worker.actor.id || worker.actor.id === (task.input as ReporterInput).from.id)) {
          await harness.abortTask(task.id, context);
        }
      }
      for (const worker of workers) await (await harness.conversation(worker.conversationId, context))!.abort(context, { background: true });
      notify();
      return { stopped: workers.map(worker => worker.actor.id), paused: Boolean(args.team) };
    }

    if (!args.message?.trim()) throw new Error("A nonempty message/task is required");
    if (args.action === "send" && target!.role === "main") {
      const result = await harness.commit(async tx => {
        const doc = await tx.doc(Teams);
        if (doc.requests[requestKey]) return { ...doc.requests[requestKey]! };
        if (doc.teams[actor.teamId]!.paused || (actor.role === "worker" && !findWorker(doc, actor.id)?.enabled)) throw new Error("Agent/team stopped");
        const delivery = { id: requestKey, from: actor, text: args.message!, mode: args.mode ?? "followUp" };
        await enqueue(tx, target!, delivery);
        return doc.requests[requestKey] = { delivery: delivery.id };
      }, context);
      notify();
      return result;
    }
    let prepared: AgentChange | undefined;
    let cwd: string | undefined;
    if (args.action === "spawn") {
      if (!args.name || !/^[a-zA-Z0-9][\w.-]{0,63}$/.test(args.name) || args.name === "main") throw new Error("Use a unique 1–64 character name: letters/digits, dash, underscore, dot; not main");
      cwd = await realpath(args.cwd ?? team.main.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory");
      prepared = await options.workerAgent?.(cwd) ?? {};
      // Model: per-name override, else the host's workerModel, else the main's; thinking level follows the main.
      const byName = Object.entries(options.workerModels ?? {}).find(([key]) => args.name!.toLowerCase().includes(key.toLowerCase()))?.[1];
      const model = byName ?? options.workerModel ?? team.main.model;
      options.validateModel?.(model);
      prepared = { ...prepared, cwd, model, thinkingLevel: team.main.thinking };
    }
    const control = await root();
    return control.commit(async tx => {
      const doc = await tx.doc(Teams);
      if (doc.requests[requestKey]) return { ...doc.requests[requestKey]! };
      const currentTeam = doc.teams[actor.teamId]!;
      if (currentTeam.paused || (actor.role === "worker" && !findWorker(doc, actor.id)?.enabled)) throw new Error("Agent/team stopped");
      let worker: Worker;
      if (args.action === "spawn") {
        if (currentTeam.workers[args.name!]) throw new Error("Name already exists; reuse the agent or choose a distinct name");
        const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        worker = { actor: { id: String(child.id), teamId: actor.teamId, name: args.name!, role: "worker" }, conversationId: child.id, enabled: true };
        await configure(tx, child.id, prepared!);
        currentTeam.workers[args.name!] = worker;
      } else {
        worker = findWorker(doc, target!.id)!;
        if (!worker.enabled) throw new Error("Worker stopped; start a new named worker");
      }
      const taskId = await tx.createTask(Reporter, { from: actor, worker, message: args.message!, mode: args.mode ?? "followUp" }, {
        ownership: { kind: "conversation" }, background: true,
      });
      return doc.requests[requestKey] = { taskId, workerId: worker.actor.id };
    }, context);
  }

  registry.install(defineExtension({
    name: "durable-teams", tasks: [Anchor, Reporter],
    tools: [defineTool({
      name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: ActionSchema, replay: "unsafe",
      execute: async (args, api) => {
        const worker = findWorker(await read(), String(api.conversationId));
        if (!worker?.enabled) throw new Error("Worker not active");
        const value = await action(worker.actor, args, String(api.taskId));
        return { output: [{ type: "text", text: JSON.stringify(value) }] };
      },
    })],
  }));
  harness = await Harness.open(storage, { ...options, registry }, context);
  await root();
  harness.resume();
  return {
    harness, action,
    async register(main: MainRegistration) {
      if (!/^[a-zA-Z0-9][\w-]{0,127}$/.test(main.sessionId) || ["constructor", "prototype"].includes(main.sessionId) || !main.secret || main.secret.length < 32) throw new Error("Invalid main identity/secret");
      main.cwd = await realpath(main.cwd);
      if (!(await stat(main.cwd)).isDirectory()) throw new Error("Main cwd must be a directory");
      await harness.commit(async tx => {
        const doc = await tx.doc(Teams);
        const existing = doc.teams[main.sessionId];
        if (existing && existing.main.secret !== main.secret) throw new Error("Main identity secret mismatch");
        if (existing) existing.main = main;
        else doc.teams[main.sessionId] = { main, paused: false, workers: {}, pending: {} };
      }, context);
      return mainActor(main.sessionId, (await read()).teams[main.sessionId]!);
    },
    async authenticate(sessionId: string, secret: string) {
      const team = (await read()).teams[sessionId];
      if (!team || team.main.secret !== secret) throw new Error("Unknown main identity/secret");
      return mainActor(sessionId, team);
    },
    async resume(actor: Actor) {
      await harness.commit(async tx => { (await tx.doc(Teams)).teams[actor.teamId]!.paused = false; }, context);
    },
    async pending(actor: Actor) { return Object.values((await read()).teams[actor.teamId]!.pending); },
    async ack(actor: Actor, id: string) {
      await harness.commit(async tx => { delete (await tx.doc(Teams)).teams[actor.teamId]!.pending[id]; }, context);
    },
    async publish(actor: Actor, latest: string) {
      await harness.commit(async tx => { (await tx.doc(Teams)).teams[actor.teamId]!.main.latest = latest; }, context);
    },
    subscribe(listener: () => void) { changed.add(listener); return () => { changed.delete(listener); }; },
    async watch(actor: Actor, target: string, listener: (value: unknown) => void | Promise<void>) {
      const state = await read();
      const destination = resolveTarget(state, actor, target);
      if (destination.role !== "worker") throw new Error("Only worker streams are hosted here");
      const stream = await watchEvents(harness, findWorker(state, destination.id)!.conversationId, context);
      await listener({ snapshot: stream.snapshot });
      stream.start(async events => { await listener({ events }); });
      return () => stream.stop();
    },
    close: () => harness.close(context),
  };
}
export type TeamsService = Awaited<ReturnType<typeof openTeams>>;
