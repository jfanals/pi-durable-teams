import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSummary } from "../src/protocol.ts";
import { Client } from "../src/client.ts";
import { startHost } from "../src/host.ts";
import { SocketHostSource, workerSource } from "../src/source.ts";

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for committed API state");
}

test("human socket API: roster, nested agents, live watch, transcripts and all mutations", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-api-")); const socket = join(directory, "s");
  const model = { provider: "faux", modelId: "faux-1" };
  const fake = fauxProvider({ tokensPerSecond: 100, models: [{ id: "faux-1" }, { id: "faux-2" }] });
  fake.setResponses(Array.from({ length: 100 }, () => req => {
    const last = req.messages.findLast(m => m.role !== "system");
    if (last?.role === "user" && JSON.stringify(last).includes("DELEGATE")) return fauxAssistantMessage(fauxToolCall("team", { action: "spawn", name: "reader", message: "Read and report" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("An answer from the faux agent. ".repeat(8));
  }));
  const models = createModels(); models.setProvider(fake.provider);
  const host = await startHost(directory, socket, { models, agentModel: async () => model, modelInfo: () => ({ window: 123456, subscription: true }) });
  const client = new Client(socket); const source = new SocketHostSource(client);
  const life = new AbortController(); const streams: Promise<void>[] = [];
  const observe = (stream: Promise<void>) => streams.push(stream.catch(error => { if (!life.signal.aborted) throw error; }));
  let roster: AgentSummary[] = []; const frames: AgentSummary[][] = [];
  const identity = { sessionId: "external", secret: "s".repeat(36) };
  try {
    assert.deepEqual((await source.models()).map(model => ({ provider: model.provider, modelId: model.modelId, thinkingLevels: model.thinkingLevels })), [
      { provider: "faux", modelId: "faux-1", thinkingLevels: ["off"] },
      { provider: "faux", modelId: "faux-2", thinkingLevels: ["off"] },
    ]);
    observe(source.roster(life.signal, rows => { roster = rows; frames.push(rows); }));
    await until(() => frames.length > 0);
    const created = await source.newAgent({ name: "lead", cwd: directory }, { requestId: "create" });
    assert.ok(created.id);
    assert.deepEqual(await source.newAgent({ name: "lead", cwd: directory }, { requestId: "create" }), created);
    const target = created.id!;
    await until(() => roster.some(row => row.id === target));
    assert.equal(roster[0]!.model, "faux-1");
    assert.equal(roster[0]!.contextWindow, 123456);
    assert.equal(roster[0]!.subscription, true);
    let snapshots = 0; let events = 0;
    observe(source.watch(target, life.signal, frame => { const f = frame as any; if (f.snapshot) snapshots++; if (f.events) events++; }));
    await until(() => snapshots > 0);
    const sent = await source.send(target, "DELEGATE", "followUp", { requestId: "send" });
    assert.deepEqual(await source.send(target, "DELEGATE", "followUp", { requestId: "send" }), sent);
    await until(() => frames.some(rows => rows.some(row => row.id === target && row.running)));
    await until(() => roster[0]?.children.length === 1 && !roster[0]?.running && !roster[0]?.children[0]?.running);
    assert.ok(events > 0);
    assert.ok(frames.some(rows => rows.some(row => row.activity)));
    const child = roster[0]!.children[0]!;
    await source.send(child.id, "Human input", "steer");
    await until(async () => JSON.stringify(await source.page(child.id)).includes("Human input"));
    const page = await source.page(target);
    assert.ok(page.entries.length > 0);
    if (page.next) await source.page(target, page.next);
    const bound = workerSource(source, target);
    assert.equal((await bound.status()).id, target);
    assert.ok((await bound.page()).entries.length > 0);
    await source.setModel(target, "faux", "faux-2", "high", { requestId: "create" });
    await until(() => roster[0]?.model === "faux-2" && roster[0]?.thinking === "high");
    await source.rename(target, "renamed", { requestId: "rename" });
    await until(() => roster[0]?.name === "renamed");
    await source.send(target, "Next request");
    await until(() => roster[0]?.running === true);
    assert.deepEqual((await source.stop(target)).aborted, [target]);
    assert.equal((await source.list())[0]!.enabled, true);
    await source.disable(target);
    await until(() => roster[0]?.enabled === false && roster[0]?.children[0]?.enabled === false);
    await client.call("register", { ...identity, name: "Pi main", cwd: directory, model });
    await client.call("publish", { ...identity, latest: "Published observation" });
    await until(() => roster.some(row => row.id === identity.sessionId && row.latest === "Published observation"));
    const external = (await source.list()).find(row => row.id === identity.sessionId)!;
    assert.equal(external.connected, false);
    assert.equal(external.cwd, await realpath(directory));
    assert.equal(external.enabled, true);
    observe(client.stream("events", identity, life.signal, () => {}));
    await until(() => roster.some(row => row.id === identity.sessionId && row.connected));
    assert.ok((await source.send(identity.sessionId, "Hello Pi")).delivery);
    await assert.rejects(source.page(identity.sessionId), /external/i);
    await assert.rejects(source.rename(identity.sessionId, "no"), /cannot be renamed/);
    for (const route of ["agents/watch", "watch"]) {
      const response = await new Promise<{ status?: number; contentType?: string; body: { error: string } }>((resolve, reject) => {
        const req = request({ socketPath: socket, path: `/${route}?refresh=1`, method: "POST" }, res => {
          let text = ""; res.on("data", chunk => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], body: JSON.parse(text) }));
        });
        req.on("error", reject); req.end(JSON.stringify({ ...identity, target: identity.sessionId }));
      });
      assert.equal(response.status, 400);
      assert.equal(response.contentType, "application/json");
      assert.match(response.body.error, /Pi sessions have no hosted transcript/);
    }
    // GET is available as well as the typed client's POST list.
    const get = await new Promise<AgentSummary[]>((resolve, reject) => {
      const req = request({ socketPath: socket, path: "/agents?refresh=1", method: "GET" }, res => {
        let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(JSON.parse(text)));
      }); req.on("error", reject); req.end();
    });
    assert.equal(get.length, 2);
    await assert.rejects(client.call("agents/send", { target, message: "bad mode", mode: "wrong" }), /Invalid/);
  } finally {
    life.abort(); await Promise.all(streams); await host.close(); await rm(directory, { recursive: true, force: true });
  }
});
