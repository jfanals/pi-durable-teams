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
import { AgentDoc, configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, MemoryStorage, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { human, openTeams, Teams, type TeamsService } from "../src/teams.ts";
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
const roster = async (service: TeamsService, actor = human) => await service.action(actor, { action: "list" }, "") as Actor[];
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
    await assert.rejects(service.action(a, { action: "stop", team: true }, "invalid-team-stop"), /external Pi sessions/);
    await assert.rejects(service.action(a, { action: "newAgent", name: "forbidden", cwd: directory }, "x"), /human/);
    await assert.rejects(service.action(b, { action: "stop", target: a.id }, "x"), /accessible/);
    assert.ok(!(await roster(service, a)).some(agent => agent.id === b.id));
    assert.ok((await service.action(a, { action: "list", scope: "mains" }, "") as Actor[]).some(agent => agent.id === b.id));
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
    assert.match(JSON.stringify(await page(service, a.id)), /teams.report/);
    assert.ok(!(await roster(service, b)).some(agent => agent.id === reader.id));
    for (const action of ["send", "inspect", "stop", "abort"] as const) await assert.rejects(service.action(b, { action, target: reader.id, message: "no", model }, action), /accessible/);
    await assert.rejects(service.action(reader, { action: "spawn", name: "nested", message: "no" }, "x"), /cannot spawn/);
    await settle(service, await service.action(a, { action: "send", target: b.id, message: "Coordinate" }, "peer"));
    await idle(service, a.id);
    const history = JSON.stringify(await page(service, a.id));
    assert.match(history, /teams.report/); assert.match(history, /"name":"B"/);
    await settle(service, await service.action(human, { action: "send", target: reader.id, message: "Human follow-up" }, "human"));
    assert.match(JSON.stringify(await page(service, reader.id)), /Human follow-up/);
    assert.deepEqual(await service.pending(human), []);
    await assert.rejects(service.action(a, { action: "model", target: reader.id, model: alternate }, "denied-model"), /human/);
    await service.action(human, { action: "model", target: reader.id, model: alternate, thinking: "high" }, "model");
    await settle(service, await service.action(human, { action: "send", target: reader.id, message: "Next model" }, "next"));
    const configured = await service.action(human, { action: "inspect", target: reader.id }, "") as any;
    assert.deepEqual(configured.agent.model, alternate); assert.equal(configured.latest.model, "faux-2");
    assert.equal(configured.agent.thinkingLevel, "high");
    await assert.rejects(service.action(a, { action: "rename", target: a.id, name: "renamed" }, "denied-rename"), /human/);
    await assert.rejects(service.action(human, { action: "rename", target: a.id, name: "B" }, "duplicate-rename"), /Name already exists/);
    await assert.rejects(service.action(human, { action: "rename", target: a.id, name: "main" }, "invalid-rename"), /unique/);
    await service.action(human, { action: "rename", target: a.id, name: "renamed" }, "rename");
    const renamed = await service.action(human, { action: "inspect", target: a.id }, "") as any;
    assert.match(renamed.agent.instructions, /^You are agent renamed\./);
    assert.match(renamed.agent.instructions, /Project instructions/);
    await service.close(); service = await open();
    assert.equal((await roster(service)).find(agent => agent.id === a.id)!.name, "renamed");
    assert.equal((await roster(service)).length, 4);
    assert.match(JSON.stringify(await page(service, reader.id)), /Human follow-up/);
    await settle(service, await service.action(a, { action: "send", target: reader.id, message: "After restart" }, "restart"));
    await service.action(human, { action: "stop", target: a.id }, "stop-parent");
    const stopped = (await service.harness.snapshot(Teams, ctx))!;
    for (const id of [a.id, reader.id, childB.workerId]) assert.equal(stopped.agents[id]!.enabled, false);
    assert.equal(stopped.agents[b.id]!.enabled, true);
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
    const first = await service.action(human, { action: "inspect", target: created.id }, "") as any;
    assert.equal(first.latest.model, "faux-2", "the next request uses the new model, including a tool-round continuation");
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
    assert.equal((await service.harness.snapshot(Teams, ctx))!.agents[abortTarget]!.enabled, true);
    await settle(service, await service.action(human, { action: "send", target: abortTarget, message: "Try again" }, "again"));
    const status = await service.action(human, { action: "inspect", target: abortTarget }, "") as any;
    assert.equal(status.latest.model, "faux-2");
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
    assert.equal(doc.agents.paused!.paused, true);
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
      const view = await conversation.viewState(ctx);
      try {
        const messages = view.value.entries.flatMap(entry => entry.model ?? []);
        const inspected = await service.action(human, { action: "inspect", target: id }, "") as any;
        assert.deepEqual(inspected.latest, messages.findLast(m => m.role === "assistant"));
        assert.equal(inspected.since, (messages.findLast(m => m.role === "user") as { timestamp?: number } | undefined)?.timestamp);
        assert.deepEqual(inspected.agent, view.value.docs["pi.agent"]);
        assert.deepEqual(inspected.live, view.value.docs["pi.live"]);
      } finally { view.dispose(); }
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
    assert.deepEqual(scans, [cid]);
    assert.equal(refreshed[0]!.find(row => row.id === a)!.since, 123);
    assert.equal(first.find(row => row.id === a)!.since, undefined); // Earlier readers retain their frame.
    scans.length = 0;
    await service.action(human, { action: "rename", target: b, name: "renamed" }, "rename-cached");
    assert.equal((await service.agents()).find(row => row.id === b)!.name, "renamed");
    assert.deepEqual(scans, [Number(b)]);
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
    const mains = async (archived?: boolean) => (await service.action(lead, { action: "list", scope: "mains", ...(archived ? { archived } : {}) }, "") as Actor[]).map(agent => agent.id);
    assert.deepEqual(await mains(), [id], "hidden by default");
    assert.deepEqual((await mains(true)).sort(), [id, other].sort(), "archived: true shows them");
    await assert.rejects(service.action(lead, { action: "send", target: other, message: "hi" }, "s1"), /archived; the human must unarchive/);
    await assert.rejects(service.action(human, { action: "newAgent", name: "shelved", cwd: process.cwd() }, "dup"), /archived agent/);
    await service.unarchive(other);
    assert.deepEqual((await mains()).sort(), [id, other].sort());
    assert.ok(await service.action(lead, { action: "send", target: other, message: "hi again" }, "s2"));
  } finally { await service.close(); }
});
