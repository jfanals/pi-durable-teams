import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Value } from "typebox/value";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, InboxDoc, LiveDoc, configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, MemoryStorage, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { human, openTeams, Teams, type TeamsService } from "../src/teams.ts";
import { textOf } from "../src/status.ts";
import { ActionSchema, type Actor } from "../src/protocol.ts";

const model = { provider: "faux", modelId: "faux-1" };
const alternate = { provider: "faux", modelId: "faux-2" };
function fixture() {
  const fake = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] }); const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses(Array.from({ length: 100 }, () => request => {
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "user" && JSON.stringify(last).includes("DELEGATE")) return fauxAssistantMessage(fauxToolCall("team", { action: "spawn", name: "reader", message: "Read and report" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("Answer from agent");
  }));
  return { fake, models };
}
async function settle(service: TeamsService, result: any) {
  const task = await service.harness.waitForTask(result.taskId as TaskId, ctx);
  assert.equal(task.state.outcome.status, "completed", JSON.stringify(task.state));
}
type Row = { id: string; name: string; status: string; children?: Row[] };
/** Every agent the actor's `list` shows, flattened, as actors. */
const roster = async (service: TeamsService, actor = human, scope?: "mains") => {
  const flat = (rows: Row[]): Row[] => rows.flatMap(row => row.id === undefined ? [] : [row, ...flat(row.children ?? [])]);
  const state = (await service.harness.snapshot(Teams, ctx))!;
  return flat(await service.action(actor, { action: "list", all: true, ...(scope ? { scope } : {}) }, "") as Row[])
    .map(row => ({ id: row.id, name: row.name, teamId: state.agents[row.id]!.parent ?? row.id, role: state.agents[row.id]!.parent ? "worker" : "main" }) as Actor);
};
/** The agent's latest assistant message, as stored. */
async function conversationLatest(service: TeamsService, id: string) {
  const { messages } = await (await service.harness.conversation(Number(id) as ConversationId, ctx))!.context(ctx);
  return messages.findLast(m => m.role === "assistant") as any;
}
const page = (service: TeamsService, target: string) => service.action(human, { action: "inspect", target, transcript: true }, "");
async function idle(service: TeamsService, id: string) {
  await (await service.harness.conversation(Number(id) as ConversationId, ctx))!.waitForIdle(ctx);
}

test("hosted agents delegate, exchange reports, obey tree reach and persist across SQLite restart", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-")); const db = join(directory, "agents.sqlite");
  const options = { models: fixture().models, agentModel: async () => ({ ...model, thinking: "medium" as const }), workerAgent: async () => ({ instructions: "Project instructions" }) };
  const open = async () => openTeams(await openNodeSqliteStorage(db), options);
  let service = await open();
  try {
    assert.ok(!("model" in ActionSchema.properties));
    assert.ok(!("thinking" in ActionSchema.properties));
    assert.equal(Value.Check(ActionSchema, { action: "newAgent" }), false);
    assert.equal(Value.Check(ActionSchema, { action: "model" }), false);
    assert.equal(Value.Check(ActionSchema, { action: "rename", target: "1", name: "x" }), false);
    const concurrent = await Promise.allSettled(["a", "a-race"].map(request =>
      service.action(human, { action: "newAgent", name: "A", cwd: directory }, request)));
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(result => result.status === "rejected").length, 1);
    const created = concurrent.find(result => result.status === "fulfilled")!;
    assert.ok(created.status === "fulfilled" && (created.value as any).id);
    await service.action(human, { action: "newAgent", name: "B", cwd: directory }, "b");
    const a = (await roster(service)).find(agent => agent.name === "A")!;
    const b = (await roster(service)).find(agent => agent.name === "B")!;
    await assert.rejects(service.action(a, { action: "newAgent", name: "forbidden", cwd: directory }, "x"), /human/);
    await assert.rejects(service.action(b, { action: "abort", target: a.id }, "x"), /accessible/);
    assert.ok(!(await roster(service, a)).some(agent => agent.id === b.id));
    assert.ok((await roster(service, a, "mains")).some(agent => agent.id === b.id));
    const childB = await service.action(a, { action: "spawn", name: "B", message: "A child sharing a peer's name" }, "child-b") as any;
    await settle(service, childB);
    assert.equal((await service.action(a, { action: "inspect", target: "B" }, "") as any).id, childB.workerId);
    // Imported state can contain duplicate names: never silently choose among matching siblings.
    await service.harness.commit(async tx => { (await tx.doc(Teams)).agents[b.id]!.name = "A"; }, ctx);
    await assert.rejects(service.action(human, { action: "inspect", target: "A" }, ""), error =>
      String(error).includes(a.id) && String(error).includes(b.id) && /Ambiguous/.test(String(error)));
    await service.harness.commit(async tx => { (await tx.doc(Teams)).agents[b.id]!.name = "B"; }, ctx);
    // A's model invokes the same team tool used by external Pi sessions.
    await settle(service, await service.action(human, { action: "send", target: a.id, message: "DELEGATE" }, "delegate"));
    const reader = (await roster(service, a)).find(agent => agent.name === "reader")!;
    const doc = (await service.harness.snapshot(Teams, ctx))!;
    assert.equal(doc.agents[reader.id]!.parent, a.id);
    const reports = (await service.harness.inspect(ctx)).tasks.filter(task => task.record.kind === "teams.reporter");
    for (const task of reports) await service.harness.waitForTask(task.record.id, ctx);
    await idle(service, a.id);
    assert.match(JSON.stringify(await page(service, a.id)), /"from":"reader"/);
    assert.ok(!(await roster(service, b)).some(agent => agent.id === reader.id));
    for (const action of ["send", "inspect", "abort"] as const) await assert.rejects(service.action(b, { action, target: reader.id, message: "no", model }, action), /accessible/);
    await assert.rejects(service.action(reader, { action: "spawn", name: "nested", message: "no" }, "x"), /cannot spawn/);
    await settle(service, await service.action(a, { action: "send", target: b.id, message: "Coordinate" }, "peer"));
    await idle(service, a.id);
    const history = JSON.stringify(await page(service, a.id));
    assert.match(history, /"from":"B"/);
    await settle(service, await service.action(human, { action: "send", target: reader.id, message: "Human follow-up" }, "human"));
    assert.match(JSON.stringify(await page(service, reader.id)), /Human follow-up/);
    assert.deepEqual(await service.pending(human), []);
    await assert.rejects(service.action(a, { action: "model", target: reader.id, model: alternate }, "denied-model"), /human/);
    await service.action(human, { action: "model", target: reader.id, model: alternate, thinking: "high" }, "model");
    await settle(service, await service.action(human, { action: "send", target: reader.id, message: "Next model" }, "next"));
    const configured = await service.action(human, { action: "inspect", target: reader.id }, "") as any;
    assert.equal(configured.model, "faux/faux-2"); assert.equal(configured.thinking, "high");
    await assert.rejects(service.action(a, { action: "rename", target: a.id, name: "renamed" }, "denied-rename"), /human/);
    await assert.rejects(service.action(human, { action: "rename", target: a.id, name: "B" }, "duplicate-rename"), /Name already exists/);
    await assert.rejects(service.action(human, { action: "rename", target: a.id, name: "main" }, "invalid-rename"), /unique/);
    await service.action(human, { action: "rename", target: a.id, name: "renamed" }, "rename");
    const renamed = (await service.harness.snapshot(AgentDoc, Number(a.id) as ConversationId, ctx))!;
    assert.match(renamed.instructions!, /^You are agent renamed\./);
    assert.match(renamed.instructions!, /Project instructions/);
    await service.close(); service = await open();
    assert.equal((await roster(service)).find(agent => agent.id === a.id)!.name, "renamed");
    assert.equal((await roster(service)).length, 4);
    assert.match(JSON.stringify(await page(service, reader.id)), /Human follow-up/);
    await settle(service, await service.action(a, { action: "send", target: reader.id, message: "After restart" }, "restart"));
    // A top-level agent launches a peer: top-level, the default agentModel, first message from A, no reminder by default.
    await assert.rejects(service.action(reader, { action: "launch", name: "fresh", message: "no" }, "x"), /top-level agents can launch/);
    const launched = await service.action(a, { action: "launch", name: "fresh", cwd: directory, message: "Start over" }, "launch") as any;
    await settle(service, launched);
    const fresh = (await service.harness.snapshot(Teams, ctx))!.agents[launched.workerId]!;
    assert.equal(fresh.parent, undefined);
    assert.ok((await roster(service, a, "mains")).some(agent => agent.id === fresh.id));
    assert.match(JSON.stringify(await page(service, fresh.id)), /Start over/);
    assert.match((await service.harness.snapshot(AgentDoc, Number(fresh.id) as ConversationId, ctx))!.instructions!, /^You are agent fresh\./);
    assert.equal((await service.action(human, { action: "inspect", target: fresh.id }, "") as any).thinking, "medium");
    await assert.rejects(service.action(a, { action: "abort", target: fresh.id }, "abort-launched"), /accessible/);
    await service.archive(a.id, "archive-parent");
    const archived = (await service.harness.snapshot(Teams, ctx))!;
    for (const id of [a.id, reader.id, childB.workerId]) assert.equal(archived.agents[id]!.archived, true);
    assert.equal(archived.agents[b.id]!.archived, undefined);
    assert.equal(archived.agents[fresh.id]!.archived, undefined);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("abort cancels a current hosted run without disabling the agent; human model changes apply on the next request", { timeout: 5000 }, async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let secondEntered!: () => void; const secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
  let gates = 0;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "gate", tools: [defineTool({ name: "gate", parameters: Type.Object({}), description: "Wait for abort", execute: async (_args, _api, context) => {
    if (++gates === 1) { entered(); await gate; }
    else { secondEntered(); await new Promise((_, reject) => context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); }
    return { output: [] };
  } })] }));
  const fake = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] }); const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }), fauxAssistantMessage("First run"), fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Next run")]);
  const service = await openTeams(new MemoryStorage(), { models, registry });
  try {
    await assert.rejects(service.action(human, { action: "newAgent", name: "missing", cwd: tmpdir() }, "missing"), /Choose/);
    const created = await service.action(human, { action: "newAgent", name: "abortable", cwd: tmpdir(), model }, "create") as any;
    const run = await service.action(human, { action: "send", target: created.id, message: "Hold" }, "hold") as any;
    await started;
    await service.action(human, { action: "model", target: created.id, model: alternate }, "model");
    release(); await settle(service, run);
    const latest = await conversationLatest(service, created.id);
    assert.equal(latest.model, "faux-2", "the next request uses the new model, including a tool-round continuation");
    const registration = { sessionId: "sender", secret: "s".repeat(36), name: "Sender", cwd: tmpdir(), model: alternate };
    await assert.rejects(service.register({ ...registration, sessionId: "123" }), /Invalid main identity/);
    const sender = await service.register(registration);
    await assert.rejects(service.action(human, { action: "abort", target: sender.id }, "external-abort"), /Pi sessions control their own runs/);
    const aborted = await service.action(sender, { action: "spawn", name: "abort-child", message: "Hold again" }, "hold-again") as any;
    const abortTarget = aborted.workerId;
    await secondStarted;
    assert.deepEqual(await service.action(sender, { action: "abort", target: abortTarget }, "abort"), { aborted: [abortTarget] });
    await idle(service, abortTarget);
    await settle(service, aborted);
    const unanswered = (await service.pending(sender)).find(delivery => delivery.request === String(aborted.taskId));
    assert.match(unanswered?.text ?? "", /unanswered \(aborted\)/);
    assert.equal((await service.harness.getTask(aborted.taskId, ctx))!.state.status, "terminal");
    assert.ok((await roster(service)).some(agent => agent.id === abortTarget));
    assert.equal((await service.harness.snapshot(Teams, ctx))!.agents[abortTarget]!.archived, undefined);
    await settle(service, await service.action(human, { action: "send", target: abortTarget, message: "Try again" }, "again"));
    const status = await service.action(human, { action: "inspect", target: abortTarget }, "") as any;
    assert.equal(status.model, "faux/faux-2");
  } finally { release(); await service.close(); }
});

test("v1 SQLite registry and in-flight reporter migrate to v2 without losing inboxes or receipts", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-v1-"));
  const workerCwd = join(directory, "worker"); await mkdir(workerCwd);
  const db = join(directory, "teams.sqlite");
  // Write a real v1 database with scheduling paused, including both reporter checkpoints.
  const V1 = defineDoc<any>({ kind: "teams.registry", version: 1, scope: "session", initial: () => ({ teams: {}, requests: {}, reported: {} }), checkpointWhen: () => false });
  const Reporter = defineTask<any, { phase: "deliver" | "report"; text?: string }, null>({ name: "teams.reporter", version: 1, initial: input => input.checkpoint ?? { phase: "deliver" }, phases: {
    deliver: async () => { throw new Error("must migrate"); }, report: async () => { throw new Error("must migrate"); },
  }, abort: async () => {} });
  const Anchor = defineTask<null, { phase: "done" }, null>({ name: "teams.anchor", version: 1, initial: () => ({ phase: "done" }),
    phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const registry = createRegistry(); registry.install(defineExtension({ name: "v1-fixture", tasks: [Anchor, Reporter] }));
  const old = await Harness.open(await openNodeSqliteStorage(db), { registry, models: fixture().models }, ctx);
  const main = { sessionId: "legacy-main", secret: "x".repeat(36), name: "Main 019a1234", cwd: directory, model };
  const from: Actor = { id: main.sessionId, teamId: main.sessionId, name: main.name, role: "main" };
  let taskId!: TaskId; let workerId!: string;
  try {
    const root = await old.root(ctx);
    await root.commit(async tx => {
      const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } }); workerId = String(child.id);
      await configure(tx, child.id, { cwd: workerCwd, model });
      const worker = { actor: { id: workerId, teamId: main.sessionId, name: "reader", role: "worker" }, conversationId: child.id, enabled: true };
      const doc = await tx.doc(V1);
      const pending = { existing: { id: "existing", from, text: "Still pending", mode: "followUp" } };
      doc.teams[main.sessionId] = { main, paused: false, workers: { reader: worker }, pending };
      doc.teams.paused = { main: { ...main, sessionId: "paused" }, paused: true, workers: {}, pending: {} };
      taskId = await tx.createTask(Reporter, { from, worker, message: "Resume old task", mode: "followUp" }, { ownership: { kind: "conversation" }, background: true });
      await tx.createTask(Reporter, { from, worker, message: "Answered already", mode: "followUp", checkpoint: { phase: "report", text: "Old checkpoint answer" } }, { ownership: { kind: "conversation" }, background: true });
      doc.requests[`${from.id}:old-request`] = { taskId, workerId };
      doc.reported["old-receipt"] = true;
    }, ctx);
  } finally { await old.close(ctx); }
  const service = await openTeams(await openNodeSqliteStorage(db), { models: fixture().models });
  try {
    await settle(service, { taskId });
    for (const task of (await service.harness.inspect(ctx)).tasks) if (task.record.kind === "teams.reporter") await service.harness.waitForTask(task.record.id, ctx);
    const actor = await service.authenticate(main.sessionId, main.secret);
    const doc = (await service.harness.snapshot(Teams, ctx))!;
    assert.equal(doc.agents[workerId]!.parent, main.sessionId);
    assert.equal(doc.agents[workerId]!.cwd, workerCwd);
    await service.register(main); // duplicate imported default names cannot break reconnection
    await service.register({ ...main, sessionId: "another", name: main.name });
    await service.register(main);
    await assert.rejects(service.action(human, { action: "inspect", target: main.name }, ""), /accessible/);
    assert.equal((await service.action(human, { action: "inspect", target: "another" }, "") as any).id, "another");
    await service.register({ ...main, name: "hosted" });
    await service.action(human, { action: "newAgent", name: "hosted", cwd: directory, model }, "hosted");
    await service.register({ ...main, name: "hosted" }); // external names may also match hosted names
    await service.register({ ...main, name: "hosted" });
    assert.equal("paused" in doc.agents.paused!, false, "version 3 drops pause");
    assert.equal(doc.reported["old-receipt"], true);
    assert.equal(doc.requests[`${from.id}:old-request`]!.taskId, taskId);
    const pending = await service.pending(actor);
    assert.equal(pending.length, 3); assert.ok(pending.some(delivery => delivery.text === "Old checkpoint answer"));
    assert.ok(pending.some(delivery => delivery.id === "existing"));
    assert.match(JSON.stringify(await page(service, workerId)), /Resume old task/);
    await service.ack(actor, "existing");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("spawn/send remind the requester once when no report arrives in time; an earlier report cancels it", { timeout: 10000 }, async () => {
  const registry = createRegistry();
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  let started = new Promise<void>(resolve => { entered = resolve; });
  registry.install(defineExtension({ name: "remind-gate", tools: [defineTool({
    name: "gate", description: "Hold an answer", parameters: Type.Object({}),
    execute: async () => { entered(); await gate; return { output: [] }; },
  })] }));
  const fake = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses(Array.from({ length: 20 }, () => request => {
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "user" && JSON.stringify(last).includes("HOLD")) return fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" });
    return fauxAssistantMessage("held answer");
  }));
  const service = await openTeams(new MemoryStorage(), { models, registry, agentModel: async () => model });
  const reminderOf = async (request: string) => (await service.harness.inspect(ctx)).tasks
    .find(({ record }) => record.kind === "teams.reminder" && (record.input as any).request === request)?.record;
  try {
    const worker = (await service.action(human, { action: "newAgent", name: "slow", cwd: tmpdir() }, "slow") as any).id;
    const sender = await service.register({ sessionId: "remind-sender", secret: "r".repeat(36), name: "Sender", cwd: tmpdir(), model });
    const late = await service.action(sender, { action: "send", target: worker, message: "HOLD", timeoutSeconds: 0.05 }, "late") as any;
    assert.equal(late.next, "end your turn; the report arrives automatically");
    await started;
    await service.harness.waitForTask((await reminderOf(String(late.taskId)))!.id, ctx);
    const reminder = (await service.pending(sender)).find(delivery => delivery.id === `teams-remind:${late.taskId}`);
    assert.match(reminder?.text ?? "", /no report for request .* after/);
    release(); await settle(service, late);
    assert.ok((await service.pending(sender)).some(delivery => delivery.id === `teams-report:${late.taskId}`), "the report still arrives after the reminder");

    gate = Promise.resolve(); started = new Promise<void>(resolve => { entered = resolve; });
    const quick = await service.action(sender, { action: "send", target: worker, message: "HOLD", timeoutSeconds: 0.5 }, "quick") as any;
    await settle(service, quick);
    await service.harness.waitForTask((await reminderOf(String(quick.taskId)))!.id, ctx);
    assert.ok(!(await service.pending(sender)).some(delivery => delivery.id === `teams-remind:${quick.taskId}`));

    const defaulted = await service.action(sender, { action: "send", target: worker, message: "again" }, "default") as any;
    assert.equal((await reminderOf(String(defaulted.taskId)))?.input && ((await reminderOf(String(defaulted.taskId)))!.input as any).seconds, 1800);
    const silent = await service.action(sender, { action: "send", target: worker, message: "again", timeoutSeconds: 0 }, "silent") as any;
    assert.equal(await reminderOf(String(silent.taskId)), undefined);
    await service.action(human, { action: "send", target: worker, message: "from human" }, "human-send");
    assert.ok(!(await service.harness.inspect(ctx)).tasks.some(({ record }) => record.kind === "teams.reminder" && (record.input as any).from.id === human.id), "the human gets no reminders");
  } finally { release(); await service.close(); }
});

test("inspection matches active view across paged tool tails, resets and compaction heads", async () => {
  const service = await openTeams(new MemoryStorage(), { models: fixture().models, agentModel: async () => model });
  try {
    const { id } = await service.action(human, { action: "newAgent", name: "status", cwd: process.cwd() }, "status") as { id: string };
    const cid = Number(id) as ConversationId;
    const conversation = (await service.harness.conversation(cid, ctx))!;
    const equivalent = async () => {
      const { messages } = await conversation.context(ctx);
      {
        const inspected = await service.action(human, { action: "inspect", target: id }, "") as any;
        assert.equal(inspected.latest, textOf(messages.findLast(m => m.role === "assistant")));
        const row = (await service.agents()).find(agent => agent.id === id)!;
        assert.equal(row.since, (messages.findLast(m => m.role === "user") as { timestamp?: number } | undefined)?.timestamp);
        assert.equal(row.running, Boolean((await service.harness.snapshot(LiveDoc, cid, ctx))?.run));
      }
    };
    await equivalent(); // Empty conversation.
    await service.harness.commit(async tx => {
      await tx.appendEntry(cid, { kind: "pi.user", model: [{ role: "user", content: "old", timestamp: 1 }] });
      await tx.appendEntry(cid, { kind: "pi.assistant", model: [fauxAssistantMessage("old answer")] });
      for (let i = 0; i < 95; i++) await tx.appendEntry(cid, { kind: "pi.tool-result", data: { text: "tool tail" } });
    }, ctx);
    await equivalent();
    await service.harness.commit(async tx => { await tx.appendEntry(cid, { kind: "pi.reset", head: "self" }); }, ctx);
    await equivalent(); // No pre-reset assistant or user leaks through.
    await service.harness.commit(async tx => {
      await tx.appendEntry(cid, { kind: "pi.reset", head: "self", model: [{ role: "user", content: "handoff", timestamp: 2 }] });
    }, ctx);
    await equivalent();
    await service.harness.commit(async tx => {
      const kept = await tx.appendEntry(cid, { kind: "pi.user", model: [{ role: "user", content: "retained", timestamp: 3 }] });
      await tx.appendEntry(cid, { kind: "pi.assistant", model: [fauxAssistantMessage("retained answer")] });
      await tx.appendEntry(cid, { kind: "pi.compaction", head: kept.id, model: [{ role: "user", content: "summary", timestamp: 4 }] });
    }, ctx);
    await equivalent(); // Retained user follows the summary in active-view order, despite its older ID.
    await service.harness.commit(async tx => {
      await tx.appendEntry(cid, { kind: "pi.compaction", head: "self", model: [{ role: "user", content: "only summary", timestamp: 5 }] });
    }, ctx);
    await equivalent();
    assert.deepEqual((await service.page(human, id)).queued, []);
    assert.deepEqual(await service.dequeue(id), { texts: [] });
  } finally { await service.close(); }
});

test("roster shares refresh work and invalidates only changed agents, branches and registry rows", async () => {
  const storage = new MemoryStorage();
  const scans: ConversationId[] = [];
  const scan = storage.scanEntries.bind(storage);
  storage.scanEntries = async (...args) => { if (args[0].conversationId !== undefined) scans.push(args[0].conversationId); return scan(...args); };
  const service = await openTeams(storage, { models: fixture().models, agentModel: async () => model });
  try {
    const create = async (name: string) => (await service.action(human, { action: "newAgent", name, cwd: process.cwd() }, name) as { id: string }).id;
    const a = await create("cached-a"), b = await create("cached-b");
    const cid = Number(a) as ConversationId;
    const first = await service.agents();
    scans.length = 0;
    const unchanged = await Promise.all(Array.from({ length: 8 }, () => service.agents()));
    assert.ok(unchanged.every(rows => rows === first));
    assert.deepEqual(scans, []);
    await service.harness.commit(async tx => {
      await tx.appendEntry(cid, { kind: "pi.user", model: [{ role: "user", content: "new", timestamp: 123 }] });
      await tx.appendEntry(cid, { kind: "pi.assistant", model: [fauxAssistantMessage("new reply")] });
    }, ctx);
    const refreshed = await Promise.all(Array.from({ length: 8 }, () => service.agents()));
    assert.ok(refreshed.every(rows => rows === refreshed[0]));
    assert.deepEqual(scans, [cid, cid], "status, then waiting-on-you asks from the new entries only");
    assert.equal(refreshed[0]!.find(row => row.id === a)!.since, 123);
    assert.equal(first.find(row => row.id === a)!.since, undefined); // Earlier readers retain their frame.
    scans.length = 0;
    await service.action(human, { action: "rename", target: b, name: "renamed" }, "rename-cached");
    assert.equal((await service.agents()).find(row => row.id === b)!.name, "renamed");
    assert.deepEqual(scans, [Number(b), Number(b)]);
    let branch!: ConversationId;
    await service.harness.commit(async tx => {
      branch = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      (await tx.doc(Teams)).agents[a]!.branches = [branch];
    }, ctx);
    await service.agents();
    scans.length = 0;
    await service.harness.commit(async tx => { await tx.appendEntry(branch, { kind: "test.branch-update" }); }, ctx);
    await service.agents();
    assert.deepEqual(scans, [cid]);
    // A commit arriving during a shared refresh must not be lost when that refresh clears its work.
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let hold = true;
    const snapshot = service.harness.snapshot.bind(service.harness) as (...args: any[]) => Promise<any>;
    service.harness.snapshot = (async (...args: any[]) => {
      const value = await snapshot(...args);
      if (hold && args[0] === AgentDoc && args[1] === cid) { hold = false; entered(); await gate; }
      return value;
    }) as typeof service.harness.snapshot;
    await service.harness.commit(async tx => { await tx.appendEntry(cid, { kind: "pi.user", model: [{ role: "user", content: "before", timestamp: 200 }] }); }, ctx);
    const pending = service.agents();
    await reading;
    try {
      await service.harness.commit(async tx => { await tx.appendEntry(cid, { kind: "pi.user", model: [{ role: "user", content: "during", timestamp: 300 }] }); }, ctx);
    } finally { release(); }
    assert.equal((await pending).find(row => row.id === a)!.since, 300);
    await service.remove(b, "remove-cached");
    assert.deepEqual((await service.agents()).map(row => row.id), [a]);
  } finally { await service.close(); }
});

test("a message sent during a manual /compact waits for the summary, shows as queued, then runs after it", { timeout: 10000 }, async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let summarizing!: () => void; const started = new Promise<void>(resolve => { summarizing = resolve; });
  const fake = fauxProvider({ models: [{ id: "faux-1" }] }); const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses(Array.from({ length: 20 }, () => async (request: any) => {
    if (JSON.stringify(request.systemPrompt ?? request.messages[0]).includes("context summarization assistant")) { summarizing(); await gate; return fauxAssistantMessage("SUMMARY"); }
    return fauxAssistantMessage("Answer " + "x ".repeat(400));
  }));
  const service = await openTeams(new MemoryStorage(), { models, agentModel: async () => model, settings: { compaction: { keepRecentTokens: 50 } } });
  try {
    const { id } = await service.action(human, { action: "newAgent", name: "compacting", cwd: tmpdir() }, "create") as { id: string };
    for (const n of [1, 2, 3]) await settle(service, await service.action(human, { action: "send", target: id, message: `Turn ${n}` }, `turn-${n}`));
    const compaction = service.compact(id);
    await started;
    const sent = await service.action(human, { action: "send", target: id, message: "After compaction" }, "after");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual((await service.page(human, id)).queued, [{ mode: "followUp", text: "After compaction" }], "held back and shown as queued");
    assert.equal((await service.agents()).find(row => row.id === id)!.running, false, "no run started during the compaction");
    release();
    assert.equal((await compaction).outcome, "compacted");
    await settle(service, sent);
    const kinds = (await service.page(human, id)).items.map(item => item.kind === "compaction" ? "compaction" : item.kind === "input" ? item.text : undefined).filter(Boolean);
    assert.ok(kinds.indexOf("compaction") >= 0 && kinds.indexOf("compaction") < kinds.findIndex(k => String(k).includes("After compaction")), JSON.stringify(kinds));
  } finally { release(); await service.close(); }
});

test("archived agents leave agents' default lists, refuse messages, and come back on unarchive", async () => {
  const service = await openTeams(new MemoryStorage(), { models: fixture().models, agentModel: async () => model });
  try {
    const { id } = await service.action(human, { action: "newAgent", name: "lead", cwd: process.cwd() }, "lead") as { id: string };
    const lead = (await roster(service)).find(agent => agent.id === id)!;
    const { id: other } = await service.action(human, { action: "newAgent", name: "shelved", cwd: process.cwd() }, "shelved") as { id: string };
    assert.deepEqual(await service.archive(other, "a1"), { archived: [other] });
    const mains = async () => (await roster(service, lead, "mains")).map(agent => agent.id);
    assert.deepEqual(await mains(), [id], "archived agents are the human's concern");
    await assert.rejects(service.action(lead, { action: "send", target: other, message: "hi" }, "s1"), /archived; the human must unarchive/);
    await assert.rejects(service.action(human, { action: "newAgent", name: "shelved", cwd: process.cwd() }, "dup"), /archived agent/);
    await service.unarchive(other);
    assert.deepEqual((await mains()).sort(), [id, other].sort());
    assert.ok(await service.action(lead, { action: "send", target: other, message: "hi again" }, "s2"));
  } finally { await service.close(); }
});

test("registry v2 migrates to v3: stopped hosted agents become archived; enabled and paused go", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-v2-"));
  const db = join(directory, "teams.sqlite");
  const V2 = defineDoc<any>({ kind: "teams.registry", version: 2, scope: "session", initial: () => ({ agents: {}, requests: {}, reported: {} }), checkpointWhen: () => false });
  const old = await Harness.open(await openNodeSqliteStorage(db), { registry: createRegistry(), models: fixture().models }, ctx);
  try {
    await (await old.root(ctx)).commit(async tx => {
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const doc = await tx.doc(V2);
      doc.agents = {
        lead: { id: "lead", name: "lead", cwd: directory, enabled: true, where: { kind: "external", session: {}, inbox: {} }, paused: true },
        done: { id: "done", name: "done", parent: "lead", cwd: directory, enabled: false, where: { kind: "hosted", conversationId: child.id } },
      };
      doc.requests = { r: { stopped: ["done"] } };
    }, ctx);
  } finally { await old.close(ctx); }
  const service = await openTeams(await openNodeSqliteStorage(db), { models: fixture().models });
  try {
    const doc = (await service.harness.snapshot(Teams, ctx))!;
    assert.deepEqual(Object.values(doc.agents).map(a => [a.id, a.archived ?? false, "enabled" in a, "paused" in a]),
      [["lead", false, false, false], ["done", true, false, false]]);
    assert.deepEqual(doc.requests.r, { stopped: ["done"] }, "stored request results are replayed as they were");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("waiting on you: replies open and close asks by title; the roster carries the open ones, read incrementally", async () => {
  const service = await openTeams(new MemoryStorage(), { models: fixture().models, agentModel: async () => model });
  try {
    const { id } = await service.action(human, { action: "newAgent", name: "asks", cwd: process.cwd() }, "asks") as { id: string };
    const cid = Number(id) as ConversationId;
    const reply = (text: string) => service.harness.commit(async tx => { await tx.appendEntry(cid, { kind: "pi.assistant", model: [fauxAssistantMessage(text)] }); }, ctx);
    const asks = async () => ((await service.agents()).find(agent => agent.id === id)!.asks ?? []).map(ask => [ask.title, ask.text]);
    assert.deepEqual(await asks(), []);
    await reply("Status table.\n\n- [ ] **Webhook URLs**: (a) source (b) secrets. I recommend (b).\n- [ ] **Secret writes**: separate command?\n- [ ] not an ask");
    assert.deepEqual(await asks(), [["Webhook URLs", "(a) source (b) secrets. I recommend (b)."], ["Secret writes", "separate command?"]]);
    const entry = (await service.agents()).find(agent => agent.id === id)!.asks![0]!.entry;
    assert.match(JSON.stringify((await page(service, id) as any).items.find((item: any) => item.id === entry)), /Webhook URLs/, "an ask points at the reply that asked it");
    // Closing matches the title case-insensitively; a partial answer closes and reopens a narrower ask.
    await reply("- [x] **webhook urls**: (b).\n- [ ] **Webhook URLs: Zapier**: keep target URLs?");
    assert.deepEqual((await asks()).map(([title]) => title), ["Secret writes", "Webhook URLs: Zapier"]);
    await reply("* [X] **Secret writes**\n* [x] **Webhook URLs: Zapier**: yes");
    assert.deepEqual(await asks(), []);
    // The human's "Re: Title — " line closes an ask at once: while the message waits in the inbox, then once placed.
    // Another agent's message does not; the agent can still ask again under the same title.
    await reply("- [ ] **Name**: a or b?\n- [ ] **Colour**: red?\n- [ ] **Size**: big?");
    const message = (from: Actor, text: string) => ({ kind: "teams.message", data: { from, message: text } });
    const peer: Actor = { id: "peer", teamId: "peer", role: "main", name: "peer" };
    await service.harness.commit(async tx => { await tx.appendEntry(cid, { ...message(peer, "Re: Size — big"), model: [{ role: "user", content: "x", timestamp: 0 }] }); }, ctx);
    await service.harness.commit(async tx => { (await tx.doc(InboxDoc, cid)).items.push({ id: "q1" as any, mode: "followUp", content: "Re: Name — a", entry: message(human, "thanks\nRe: name — a\nmore") as any }); }, ctx);
    assert.deepEqual((await asks()).map(([title]) => title), ["Colour", "Size"]);
    await service.harness.commit(async tx => { (await tx.doc(InboxDoc, cid)).items.splice(0); await tx.appendEntry(cid, { ...message(human, "Re: Name — a\nRe: Colour — red"), model: [{ role: "user", content: "x", timestamp: 0 }] }); }, ctx);
    assert.deepEqual((await asks()).map(([title]) => title), ["Size"]);
    await reply("- [ ] **Name**: a, but which a?");
    assert.deepEqual((await asks()).map(([title]) => title), ["Size", "Name"]);
    // Indented list items under an ask are its options; a nested checkbox or an unindented item is not one.
    await reply("Intro.\n- [ ] **Scope**: which?\n  - Asks only (recommended): smaller\n  1. Both\n  - [ ] **Nested**: x\n- Not an option\n- [ ] **Plain**: y");
    const options = Object.fromEntries((await service.agents()).find(agent => agent.id === id)!.asks!.map(ask => [ask.title, ask.options]));
    assert.deepEqual(options, { Size: undefined, Name: undefined, Scope: ["Asks only (recommended): smaller", "Both"], Nested: undefined, Plain: undefined });
  } finally { await service.close(); }
});
