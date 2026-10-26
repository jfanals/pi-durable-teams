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
import { configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, MemoryStorage, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
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
    await service.close(); service = await open();
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
