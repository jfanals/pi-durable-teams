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

test("team wait joins two answers in one agent run, suppresses reports, times out and honours reach/abort", { timeout: 10000 }, async () => {
  const registry = createRegistry();
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  let started = new Promise<void>(resolve => { entered = resolve; });
  registry.install(defineExtension({ name: "wait-gate", tools: [defineTool({
    name: "gate", description: "Hold an answer", parameters: Type.Object({}),
    execute: async () => { entered(); await gate; return { output: [] }; },
  })] }));
  const fake = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels(); models.setProvider(fake.provider);
  let a!: string; let b!: string;
  fake.setResponses(Array.from({ length: 100 }, () => request => {
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "user" && JSON.stringify(last).includes("JOIN")) return fauxAssistantMessage([
      fauxToolCall("team", { action: "send", target: a, message: "HOLD" }),
      fauxToolCall("team", { action: "send", target: b, message: "HOLD" }),
    ], { stopReason: "toolUse" });
    if (last?.role === "user" && JSON.stringify(last).includes("HOLD")) return fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" });
    if (last?.role === "toolResult" && last.toolName === "team") {
      const text = last.content.filter(part => part.type === "text").map(part => part.text).join("");
      const result = JSON.parse(text);
      if (!("answers" in result)) return fauxAssistantMessage(fauxToolCall("team", { action: "wait" }), { stopReason: "toolUse" });
      assert.equal(result.answers.length, 2); assert.deepEqual(result.pending, []);
      for (const answer of result.answers) assert.match(JSON.stringify(answer.answer), /joined answer/);
      return fauxAssistantMessage("Both answers in the same run");
    }
    return fauxAssistantMessage("joined answer");
  }));
  const service = await openTeams(new MemoryStorage(), { models, registry, agentModel: async () => model });
  try {
    const leader = await service.action(human, { action: "newAgent", name: "lead", cwd: tmpdir() }, "lead") as any;
    a = (await service.action(human, { action: "newAgent", name: "one", cwd: tmpdir() }, "one") as any).id;
    b = (await service.action(human, { action: "newAgent", name: "two", cwd: tmpdir() }, "two") as any).id;
    const run = await service.action(human, { action: "send", target: leader.id, message: "JOIN" }, "join") as any;
    await started;
    // Wait for the actual tool reservation, not a wall-clock guess.
    await new Promise<void>(resolve => {
      const off = service.subscribe(() => { void service.harness.snapshot(Teams, ctx).then(doc => {
        if (Object.keys(doc?.waiting ?? {}).length === 2) { off(); resolve(); }
      }); });
    });
    release(); await settle(service, run); await idle(service, leader.id);
    const history = JSON.stringify(await page(service, leader.id));
    assert.match(history, /Both answers in the same run/);
    assert.doesNotMatch(history, /teams.report/);

    gate = new Promise<void>(resolve => { release = resolve; });
    started = new Promise<void>(resolve => { entered = resolve; });
    const sender = await service.register({ sessionId: "wait-sender", secret: "w".repeat(36), name: "Wait sender", cwd: tmpdir(), model });
    const pending = await service.action(sender, { action: "send", target: a, message: "HOLD" }, "pending") as any;
    await started;
    await assert.rejects(service.action(human, { action: "wait", request: String(pending.taskId) }, ""), /Unknown request/);
    const timed = await service.action(sender, { action: "wait", request: [String(pending.taskId)], timeoutSeconds: 0.01 }, "") as any;
    assert.deepEqual(timed.answers, []); assert.deepEqual(timed.pending, [String(pending.taskId)]);
    const reservation = (id: string, count: number) => new Promise<void>(resolve => {
      const check = () => { void service.harness.snapshot(Teams, ctx).then(doc => {
        if ((doc?.waiting?.[id] ?? 0) === count) { off(); resolve(); }
      }); };
      const off = service.subscribe(check); check();
    });
    const controller = new AbortController();
    const waiting = service.action(sender, { action: "wait", request: String(pending.taskId) }, "", controller.signal);
    await reservation(String(pending.taskId), 1);
    controller.abort(new Error("Esc"));
    await assert.rejects(waiting, /Esc/);
    release(); await settle(service, pending);
    assert.ok((await service.pending(sender)).some(report => report.request === String(pending.taskId)), "timeout/abort must not withdraw the automatic report");
    const result = await service.action(sender, { action: "wait", request: String(pending.taskId) }, "") as any;
    assert.match(JSON.stringify(result.answers[0].answer), /joined answer/);
    assert.deepEqual(result.pending, []);
    assert.deepEqual(await service.action(sender, { action: "wait" }, ""), { answers: [], pending: [] });

    // Two invocations own independent reservations. Cancelling one cannot expose the
    // other's answer to automatic external delivery.
    gate = new Promise<void>(resolve => { release = resolve; });
    started = new Promise<void>(resolve => { entered = resolve; });
    const concurrent = await service.action(sender, { action: "send", target: a, message: "HOLD" }, "concurrent") as any;
    await started;
    const cancel = new AbortController();
    const firstWait = service.action(sender, { action: "wait", request: String(concurrent.taskId) }, "", cancel.signal);
    const secondWait = service.action(sender, { action: "wait" }, "");
    await reservation(String(concurrent.taskId), 2);
    cancel.abort(new Error("Esc concurrent"));
    await assert.rejects(firstWait, /Esc concurrent/);
    await reservation(String(concurrent.taskId), 1);
    release();
    assert.equal((await secondWait as any).answers.length, 1);
    assert.ok(!(await service.pending(sender)).some(report => report.request === String(concurrent.taskId)));

    // Deterministic lost-answer race: hold the harness wait's observation until the
    // Reporter has suppressed AND settled, then release the reservation via Esc.
    // Its terminal receipt must already contain the exact suppressed checkpoint text.
    gate = new Promise<void>(resolve => { release = resolve; });
    started = new Promise<void>(resolve => { entered = resolve; });
    const hostedSender = (await roster(service)).find(actor => actor.id === leader.id)!;
    const raced = await service.action(hostedSender, { action: "send", target: a, message: "HOLD" }, "race") as any;
    await started;
    const originalWait = service.harness.waitForTask.bind(service.harness);
    let observed!: () => void;
    const terminalObserved = new Promise<void>(resolve => { observed = resolve; });
    let unblock!: () => void;
    const observationGate = new Promise<void>(resolve => { unblock = resolve; });
    service.harness.waitForTask = async (id, context) => {
      const task = await originalWait(id, context);
      if (id === raced.taskId) { observed(); await observationGate; }
      return task;
    };
    const esc = new AbortController();
    const raceWait = service.action(hostedSender, { action: "wait", request: String(raced.taskId) }, "", esc.signal);
    await reservation(String(raced.taskId), 1);
    release(); await terminalObserved;
    const suppressed = (await service.harness.getTask(raced.taskId, ctx))!;
    assert.equal(suppressed.state.status, "terminal");
    assert.match(JSON.stringify(suppressed.state.outcome), /joined answer/);
    assert.ok(!JSON.stringify(await page(service, leader.id)).includes(`"request":"${raced.taskId}"`));
    esc.abort(new Error("Esc after suppression"));
    await assert.rejects(raceWait, /Esc after suppression/);
    unblock(); service.harness.waitForTask = originalWait;
    assert.ok(JSON.stringify(await page(service, leader.id)).includes(`"request":"${raced.taskId}"`));
    await reservation(String(raced.taskId), 0);
  } finally { release(); await service.close(); }
});
