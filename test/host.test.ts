import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { startHost } from "../src/host.ts";
import { Client } from "../src/client.ts";

const fixture = fileURLToPath(new URL("./fixtures/host.ts", import.meta.url));
function launch(directory: string, socket: string, slow = false) {
  const child = spawn(process.execPath, ["--no-warnings", fixture, directory, socket], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_SLOW: slow ? "1" : "" },
  });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", code => reject(new Error(`Host exited ${code}: ${stderr}`)));
    child.once("error", reject);
  });
  return { child, ready };
}
async function terminate(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill(signal); await exited;
}

test("IPC: crash recovery, pending offline reports, snapshot stream and exclusive storage owner", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-ipc-")); const socket = join(directory, "s");
  const client = new Client(socket);
  let host = launch(directory, socket, true); await host.ready;
  const identity = { sessionId: "ipc-main", secret: "s".repeat(36) };
  const registration = { ...identity, name: "IPC main", cwd: directory, model: { provider: "faux", modelId: "faux-1" } };
  const streams: AbortController[] = [];
  try {
    await client.call("register", registration);
    await assert.rejects(client.call("action", { ...identity, secret: "wrong", args: { action: "list" } }), /secret/);
    const loser = launch(directory, socket);
    await assert.rejects(loser.ready, /already owns/);
    assert.equal((await client.call("health")).ready, true);
    const result = await client.call("action", { ...identity, args: { action: "spawn", name: "reader", message: "long work" }, requestId: "create" });
    // Snapshot/live stream proves work is underway before an actual SIGKILL.
    const watching = new AbortController(); streams.push(watching);
    let sawWork!: () => void; const work = new Promise<void>(resolve => { sawWork = resolve; });
    const watch = client.stream("watch", { ...identity, target: "reader" }, watching.signal, value => {
      if (value.snapshot?.run || value.snapshot?.generation || value.events?.some((event: any) => event.type === "message_update")) sawWork();
    }).catch(error => { if (!watching.signal.aborted && !String(error).includes("aborted")) throw error; });
    await work;
    await terminate(host.child, "SIGKILL"); watching.abort(); await watch;
    host = launch(directory, socket); await host.ready;
    await client.call("register", registration);
    const connected = new AbortController(); streams.push(connected);
    let delivered!: (value: any) => void; const delivery = new Promise<any>(resolve => { delivered = resolve; });
    const stream = client.stream("events", identity, connected.signal, value => { delivered(value.delivery); }).catch(() => {});
    const report = await delivery;
    assert.match(report.text, /recovered answer/);
    assert.equal(report.request, String(result.taskId));
    const inspected = await client.call("action", { ...identity, args: { action: "inspect", request: String(result.taskId) } });
    assert.equal(inspected.state.outcome.status, "completed");
    connected.abort(); await stream;
    // A reconnect replays unacknowledged deliveries; acknowledgement survives another restart.
    await client.call("ack", { ...identity, id: report.id });
    await terminate(host.child); host = launch(directory, socket); await host.ready;
    await client.call("register", registration);
    const retry = await client.call("action", { ...identity, args: { action: "spawn", name: "reader", message: "long work" }, requestId: "create" });
    assert.deepEqual(retry, result);
  } finally {
    for (const stream of streams) stream.abort();
    await terminate(host.child); await rm(directory, { recursive: true, force: true });
  }
});

test("main transport queues until persisted acknowledgement; duplicate main client is rejected", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-stream-")); const socket = join(directory, "s");
  const fake = fauxProvider(); fake.setResponses([fauxAssistantMessage("done")]);
  const models = createModels(); models.setProvider(fake.provider);
  const host = await startHost(directory, socket, { models }); const client = new Client(socket);
  const a = { sessionId: "a", secret: "a".repeat(36) }; const b = { sessionId: "b", secret: "b".repeat(36) };
  const lives: AbortController[] = [];
  try {
    for (const identity of [a, b]) await client.call("register", { ...identity, name: identity.sessionId, cwd: directory, model: { provider: "faux", modelId: "faux-1" } });
    const message = "hello " + "large-report ".repeat(20000);
    await client.call("action", { ...a, args: { action: "send", target: "b", message }, requestId: "hello" });
    const life = new AbortController(); lives.push(life);
    let resolve!: (x: any) => void; const received = new Promise<any>(r => { resolve = r; });
    const stream = client.stream("events", b, life.signal, value => { resolve(value.delivery); }).catch(() => {});
    const delivery = await received;
    assert.equal(delivery.from.id, "a");
    assert.equal(delivery.text, message);
    await assert.rejects(client.stream("events", b, AbortSignal.timeout(1000), () => {}), /already has a connected client/);
    assert.equal((await host.service.pending(await host.service.authenticate(b.sessionId, b.secret))).length, 1);
    await client.call("ack", { ...b, id: delivery.id });
    assert.equal((await host.service.pending(await host.service.authenticate(b.sessionId, b.secret))).length, 0);
    life.abort(); await stream;
  } finally { lives.forEach(life => life.abort()); await host.close(); await rm(directory, { recursive: true, force: true }); }
});
