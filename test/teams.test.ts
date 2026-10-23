import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openTeams, type TeamsService } from "../src/teams.ts";

const ctx = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };
function models() {
  const fake = fauxProvider();
  const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses(Array.from({ length: 100 }, () => request => {
    const last = request.messages.findLast(m => m.role !== "system");
    const text = JSON.stringify(last);
    if (last?.role !== "toolResult" && text.includes("USE_TEAM_LIST")) return fauxAssistantMessage(fauxToolCall("team", { action: "list" }), { stopReason: "toolUse" });
    return fauxAssistantMessage(`answer: ${text}`);
  }));
  return { models, fake };
}
async function main(service: TeamsService, sessionId: string, cwd: string) {
  return service.register({ sessionId, secret: sessionId.padEnd(36, "x"), name: `Main ${sessionId}`, cwd, model });
}
async function settle(service: TeamsService, result: any) {
  assert.ok(result.taskId);
  const task = await service.harness.waitForTask(result.taskId as TaskId, ctx);
  assert.equal(task.state.outcome.status, "completed", JSON.stringify(task.state));
  return task;
}

test("two teams: discovery, attribution, persistent follow-ups, latest vs request answer, dedup and scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-test-"));
  const service = await openTeams(new MemoryStorage(), { models: models().models });
  try {
    const a = await main(service, "main-a", directory);
    const b = await main(service, "main-b", directory);
    const results = [];
    for (const [actor, name] of [[a, "one"], [a, "two"], [b, "three"], [b, "four"]] as const) {
      const r = await service.action(actor, { action: "spawn", name, message: `hello ${name}` }, name);
      results.push(r); await settle(service, r);
    }
    const roster = await service.action(a, { action: "list" }, "list") as any[];
    assert.equal(roster.length, 3);
    assert.ok(!JSON.stringify(roster).includes("three"));
    const peers = await service.action(a, { action: "list", scope: "mains" }, "mains") as any[];
    assert.equal(peers.length, 2);
    const worker = roster.find(w => w.name === "one");
    await assert.rejects(service.action(worker, { action: "list", scope: "mains" }, "bad"), /Only mains/);
    await assert.rejects(service.action(worker, { action: "spawn", name: "nested", message: "no" }, "bad"), /cannot spawn/);
    await assert.rejects(service.action(worker, { action: "send", target: "main-b", message: "no" }, "bad"), /accessible/);
    const peer = await service.action(worker, { action: "send", target: "two", message: "question for sibling" }, "peer");
    await settle(service, peer);
    assert.deepEqual(await service.action(worker, { action: "send", target: "two", message: "question for sibling" }, "peer"), peer);
    const follow = await service.action(a, { action: "send", target: "one", message: "follow up" }, "follow");
    await settle(service, follow);
    const inspected = await service.action(a, { action: "inspect", target: "one" }, "inspect") as any;
    assert.ok(inspected.latest);
    const transcript = await service.action(a, { action: "inspect", target: "one", transcript: true }, "log") as any;
    assert.match(JSON.stringify(transcript.entries), /hello one/);
    assert.match(JSON.stringify(transcript.entries), /follow up/);
    const result = await service.action(a, { action: "inspect", request: String((follow as any).taskId) }, "request") as any;
    assert.equal(result.answer.role, "assistant");
    assert.match(JSON.stringify(result.answer), /follow up/);
    await assert.rejects(service.action(b, { action: "inspect", request: String((follow as any).taskId) }, "bad"), /Unknown request/);
    await service.publish(b, "last main response");
    assert.equal((await service.action(a, { action: "inspect", target: "main-b" }, "latest") as any).latest, "last main response");
    await service.action(a, { action: "send", target: "main-b", message: "cross team" }, "cross");
    await service.action(a, { action: "send", target: "main-b", message: "cross team" }, "cross");
    const pending = await service.pending(b);
    assert.equal(pending.filter(d => d.text === "cross team").length, 1);
    assert.equal(pending.find(d => d.text === "cross team")?.from.id, a.id);
    const before = (await service.pending(a)).length;
    await service.ack(a, (await service.pending(a))[0]!.id);
    assert.equal((await service.pending(a)).length, before - 1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent spawn is atomic and request retries reuse one worker/report task", async () => {
  const service = await openTeams(new MemoryStorage(), { models: models().models });
  try {
    const actor = await main(service, "concurrent", tmpdir());
    const args = { action: "spawn", name: "same", message: "work" } as const;
    const [one, two] = await Promise.all([service.action(actor, args, "same-request"), service.action(actor, args, "same-request")]);
    assert.deepEqual(one, two); await settle(service, one);
    await assert.rejects(service.action(actor, args, "other-request"), /Name already exists/);
    assert.equal((await service.action(actor, { action: "list" }, "list") as any[]).length, 2);
  } finally { await service.close(); }
});

test("worker model can invoke team; model policy and project configuration are preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-cwd-"));
  await writeFile(join(directory, "AGENTS.md"), "Never publish changes.");
  const fake = models();
  const registry = createRegistry(); registry.install(CodingTools);
  const service = await openTeams(new MemoryStorage(), {
    models: fake.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }),
    workerAgent: async cwd => ({ instructions: `Project ${cwd}: Never publish changes.` }),
    validateModel: m => { if (m.provider !== "faux") throw new Error("Provider blocked"); },
  });
  try {
    const blocked = await service.register({ sessionId: "paid", secret: "p".repeat(36), name: "Paid", cwd: directory, model: { provider: "paid", modelId: "model" } });
    await assert.rejects(service.action(blocked, { action: "spawn", name: "bad", message: "no" }, "bad"), /Provider blocked/);
    const actor = await main(service, "cwd", directory);
    const spawned = await service.action(actor, { action: "spawn", name: "reader", message: "USE_TEAM_LIST" }, "reader");
    await settle(service, spawned);
    const inspection = await service.action(actor, { action: "inspect", request: String((spawned as any).taskId) }, "inspect") as any;
    assert.match(JSON.stringify(inspection.answer), /reader/);
  } finally { await service.close(); }
  // A host workerModel replaces the main's model for new workers, under the same policy.
  const pinned = await openTeams(new MemoryStorage(), {
    models: fake.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }),
    workerModel: { provider: "faux", modelId: "faux-1" },
    // Per-name models win over workerModel: any name containing "review" gets it, other names don't.
    workerModels: { review: { provider: "claude", modelId: "opus" } },
    validateModel: m => { if (m.provider !== "faux") throw new Error(`Provider ${m.provider} blocked`); },
  });
  try {
    const paidMain = await pinned.register({ sessionId: "paid2", secret: "q".repeat(36), name: "Paid", cwd: directory, model: { provider: "paid", modelId: "model" } });
    const spawned = await pinned.action(paidMain, { action: "spawn", name: "pinned", message: "USE_TEAM_LIST" }, "pinned");
    await settle(pinned, spawned);
    await assert.rejects(pinned.action(paidMain, { action: "spawn", name: "review", message: "x" }, "r1"), /Provider claude blocked/);
    await assert.rejects(pinned.action(paidMain, { action: "spawn", name: "code-Reviewer", message: "x" }, "r2"), /Provider claude blocked/);
    await settle(pinned, await pinned.action(paidMain, { action: "spawn", name: "reader", message: "USE_TEAM_LIST" }, "r3"));
  } finally { await pinned.close(); await rm(directory, { recursive: true, force: true }); }
});

test("pending reports and request results survive reopening SQLite; no duplicate reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-reopen-"));
  const db = join(directory, "teams.sqlite");
  const open = async () => openTeams(await openNodeSqliteStorage(db), { models: models().models });
  let service = await open();
  try {
    let actor = await main(service, "persistent", directory);
    const spawned = await service.action(actor, { action: "spawn", name: "reader", message: "work" }, "create");
    await settle(service, spawned);
    const first = await service.pending(actor);
    assert.equal(first.length, 1);
    await service.close(); service = await open();
    actor = await main(service, "persistent", directory);
    assert.deepEqual(await service.pending(actor), first);
    assert.deepEqual(await service.action(actor, { action: "spawn", name: "reader", message: "work" }, "create"), spawned);
    await service.ack(actor, first[0]!.id);
    await service.close(); service = await open(); actor = await main(service, "persistent", directory);
    assert.equal((await service.pending(actor)).length, 0);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("team stop withdraws reports and freezes new delegation without touching another team", async () => {
  const service = await openTeams(new MemoryStorage(), { models: models().models });
  try {
    const a = await main(service, "stop-a", tmpdir()); const b = await main(service, "stop-b", tmpdir());
    const a1 = await service.action(a, { action: "spawn", name: "a1", message: "work" }, "a1");
    const b1 = await service.action(b, { action: "spawn", name: "b1", message: "work" }, "b1");
    await settle(service, a1); await settle(service, b1);
    await service.action(a, { action: "stop", team: true }, "stop");
    assert.equal((await service.pending(a)).length, 0);
    assert.equal((await service.pending(b)).length, 1);
    await assert.rejects(service.action(a, { action: "spawn", name: "new", message: "no" }, "no"), /paused/);
    await service.resume(a);
    await assert.rejects(service.action(a, { action: "send", target: "a1", message: "no" }, "no2"), /stopped/);
    await settle(service, await service.action(b, { action: "send", target: "b1", message: "still works" }, "again"));
  } finally { await service.close(); }
});
