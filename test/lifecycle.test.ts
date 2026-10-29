import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, LiveDoc, MemoryStorage, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openTeams } from "../src/teams.ts";

const ctx = BACKGROUND_CONTEXT;
async function setup() {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-gate", tools: [defineTool({
    name: "gate", parameters: Type.Object({}), description: "Wait for test release",
    execute: async (_args, _api, context) => {
      entered();
      await Promise.race([gate, new Promise((_, reject) => {
        context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })]);
      return { output: [{ type: "text", text: "released" }] };
    },
  })] }));
  const requests: string[] = [];
  const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses(Array.from({ length: 50 }, () => request => {
    requests.push(JSON.stringify(request.messages));
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "user" && JSON.stringify(last).includes("HOLD")) return fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" });
    return fauxAssistantMessage("finished");
  }));
  const service = await openTeams(new MemoryStorage(), { models, registry });
  const main = await service.register({ sessionId: "lifecycle-main", secret: "x".repeat(36), name: "Main", cwd: tmpdir(), model: { provider: "faux", modelId: "faux-1" } });
  const first = await service.action(main, { action: "spawn", name: "busy", message: "HOLD" }, "create") as any;
  await started;
  const worker = (await service.harness.conversation(Number(first.workerId) as ConversationId, ctx))!;
  const view = await worker.watch(ctx);
  return { service, main, first, worker, view, release, requests };
}
async function waitForInbox(view: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["worker"]["watch"]>>) {
  await new Promise<void>(resolve => {
    const check = () => ((view.value.docs["pi.inbox"] as any)?.items?.length ?? 0) >= 2;
    if (check()) return resolve();
    view.start(async () => { if (check()) resolve(); });
  });
}

test("native steer joins after the current tool round; follow-up waits for the answer", { timeout: 5000 }, async () => {
  const { service, main, first, view, release, requests } = await setup();
  try {
    const follow = await service.action(main, { action: "send", target: "busy", message: "FOLLOW_UP", mode: "followUp" }, "follow") as any;
    const steer = await service.action(main, { action: "send", target: "busy", message: "STEER_NOW", mode: "steer" }, "steer") as any;
    await waitForInbox(view); release();
    for (const task of [first, follow, steer]) await service.harness.waitForTask(task.taskId as TaskId, ctx);
    assert.match(requests[1]!, /STEER_NOW/);
    assert.doesNotMatch(requests[1]!, /FOLLOW_UP/);
    assert.match(requests.at(-1)!, /FOLLOW_UP/);
    // The first input and steer share an answer: only one report for that answer.
    assert.equal((await service.pending(main)).length, 2);
  } finally { release(); void view.stop(); await service.close(); }
});

test("/team stop aborts active tools and queued inputs; no late worker reports restart the main", { timeout: 5000 }, async () => {
  const { service, main, first, worker, view, release } = await setup();
  try {
    await service.action(main, { action: "send", target: "busy", message: "FOLLOW_UP" }, "follow");
    await service.action(main, { action: "send", target: "busy", message: "STEER_NOW", mode: "steer" }, "steer");
    await waitForInbox(view);
    await service.abortTeam(main);
    await worker.waitForIdle(ctx);
    release();
    assert.equal((await service.harness.snapshot(LiveDoc, worker.id, ctx))?.run, undefined);
    assert.equal((await service.pending(main)).length, 0);
    const task = await service.harness.getTask(first.taskId, ctx);
    assert.equal(task?.state.status, "terminal");
  } finally { release(); void view.stop(); await service.close(); }
});
