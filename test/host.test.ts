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
import { human, Teams } from "../src/teams.ts";
import { setTimeout as delay } from "node:timers/promises";
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

test("IPC: crash recovery, pending offline reports, change ticks and exclusive storage owner", { timeout: 20000 }, async () => {
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
    // The initial change tick confirms the watch attached before an actual SIGKILL.
    const watching = new AbortController(); streams.push(watching);
    let sawWork!: () => void; const work = new Promise<void>(resolve => { sawWork = resolve; });
    const watch = client.stream("watch", { ...identity, target: "reader" }, watching.signal, value => {
      if (value.changed) sawWork();
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
    const hosted = await host.service.action(human, { action: "newAgent", name: "hosted", cwd: directory, model: { provider: "faux", modelId: "faux-1" } }, "hosted") as any;
    const listed = await client.call("action", { ...a, args: { action: "list", scope: "mains" } }) as any[];
    assert.ok(listed.filter(agent => !agent.hosted).every(agent => typeof agent.connected === "boolean"));
    assert.ok(!Object.hasOwn(listed.find(agent => agent.id === hosted.id)!, "connected"));
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

test("human rosters show hosted trees only; agent mains and messaging retain external sessions", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-roster-"));
  const fake = fauxProvider(); fake.setResponses([fauxAssistantMessage("done")]);
  const models = createModels(); models.setProvider(fake.provider);
  const host = await startHost(directory, join(directory, "s"), { models });
  const client = new Client(join(directory, "s"));
  const identity = { sessionId: "external", secret: "s".repeat(36) };
  const model = { provider: "faux", modelId: "faux-1" };
  const life = new AbortController();
  let connection: Promise<void> | undefined;
  try {
    await client.call("register", { ...identity, name: "Pi main", cwd: directory, model });
    const root = await host.service.action(human, { action: "newAgent", name: "hosted", cwd: directory, model }, "root") as any;
    const actor = await host.service.authenticate(identity.sessionId, identity.secret);
    await host.service.action(actor, { action: "spawn", name: "external-child", message: "work" }, "external-child");
    await host.service.action(root, { action: "spawn", name: "hosted-child", message: "work" }, "hosted-child");
    const check = (rows: any[]) => {
      assert.deepEqual(rows.map(row => row.id), [root.id]);
      assert.deepEqual(rows[0].children.map((row: any) => row.name), ["hosted-child"]);
    };
    check(await client.call("agents")); // Offline external root and its hosted child are both absent.
    const mains = await client.call("action", { ...identity, args: { action: "list", scope: "mains" } }) as any[];
    assert.ok(mains.some(row => row.id === identity.sessionId));
    let received!: () => void;
    const delivery = new Promise<void>(resolve => { received = resolve; });
    connection = client.stream("events", identity, life.signal, () => received()).catch(() => {});
    await host.service.action(human, { action: "send", target: identity.sessionId, message: "hello" }, "hello");
    await delivery;
    check(await client.call("agents")); // Connected external roots are also absent.
    await client.stream("agents/roster", {}, life.signal, rows => { check(rows); life.abort(); }).catch(error => {
      if (!life.signal.aborted) throw error;
    });
  } finally {
    life.abort(); await connection; await host.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("human removal retires a hosted subtree without deleting history and frees its name", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-remove-"));
  let removedRuns = 0;
  const fake = fauxProvider({ tokensPerSecond: 1000 });
  fake.setResponses(Array.from({ length: 20 }, () => request => {
    const text = JSON.stringify(request);
    if (text.includes("removed work")) removedRuns++;
    return fauxAssistantMessage(text.includes("save history") ? "saved answer" : "working ".repeat(10000));
  }));
  const models = createModels(); models.setProvider(fake.provider);
  let host = await startHost(directory, join(directory, "s"), { models });
  const client = new Client(join(directory, "s"));
  const model = { provider: "faux", modelId: "faux-1" };
  const identity = { sessionId: "observer", secret: "s".repeat(36) };
  try {
    await client.call("register", { ...identity, name: "Observer", cwd: directory, model });
    const parent = await client.call("agents/new", { name: "parent", cwd: directory, model, requestId: "parent" });
    const actor = { id: parent.id, name: "parent", teamId: parent.id, role: "main" as const };
    const child = await host.service.action(actor, { action: "spawn", name: "child", message: "removed work" }, "child") as any;
    const sent = await client.call("agents/send", { target: parent.id, message: "save history", requestId: "input" });
    const ctx = (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT;
    await host.service.harness.waitForTask(sent.taskId, ctx);
    const conversation = (await host.service.harness.conversation(Number(parent.id) as any, ctx))!;
    const before = await conversation.entries({ order: "descending" }, 100, undefined, ctx);
    assert.ok(before.items.length > 0);
    const other = await client.call("agents/new", { name: "other", cwd: directory, model, requestId: "other" });
    const otherActor = { id: other.id, name: "other", teamId: other.id, role: "main" as const };
    const untouched = await host.service.action(otherActor, { action: "spawn", name: "untouched", message: "other work" }, "untouched") as any;
    while (removedRuns === 0) await delay(5);
    const waiting = host.service.action(actor, { action: "wait", request: String(child.taskId) }, "") as Promise<any>;
    while (!(await host.service.harness.snapshot(Teams, ctx))?.waiting?.[String(child.taskId)]) await delay(5);
    const removal = { target: parent.id, requestId: "remove" };
    assert.deepEqual((await client.call("agents/remove", removal)).stopped.sort(), [parent.id, child.workerId].sort());
    const waited = await Promise.race([waiting, delay(1000).then(() => assert.fail("Remove did not release the parent’s wait"))]);
    assert.deepEqual(waited.pending, []);
    assert.equal(waited.answers[0].state.outcome.status, "aborted");
    assert.deepEqual((await host.service.harness.snapshot(Teams, ctx))?.waiting, {});
    const otherState = await host.service.action(otherActor, { action: "inspect", request: String(untouched.taskId) }, "") as any;
    assert.notEqual(otherState.state.status, "terminal");
    assert.deepEqual((await client.call("agents")).map((row: any) => row.id), [other.id]);
    assert.equal((await client.call("agents"))[0].children[0].running, true);
    const listed = await client.call("action", { ...identity, args: { action: "list" } }) as any[];
    assert.ok(!listed.some(row => [parent.id, child.workerId].includes(row.id)));
    for (const target of ["parent", parent.id, child.workerId]) {
      await assert.rejects(client.call("action", { ...identity, args: { action: "send", target, message: "hello" }, requestId: `send-${target}` }), /No accessible agent/);
      await assert.rejects(client.call("action", { ...identity, args: { action: "inspect", target } }), /No accessible agent/);
    }
    assert.deepEqual(await client.call("agents/remove", removal), { stopped: [] });
    assert.deepEqual(await client.call("agents/remove", { ...removal, requestId: "again" }), { stopped: [] });
    assert.deepEqual((await conversation.entries({ order: "descending" }, 100, undefined, ctx)).items, before.items);
    await assert.rejects(client.call("action", { ...identity, args: { action: "remove", target: parent.id }, requestId: "forbidden" }), /Invalid team action/);
    const runsBeforeRestart = removedRuns;
    await host.close();
    host = await startHost(directory, join(directory, "s"), { models });
    await delay(100);
    const restarted = await client.call("agents");
    assert.deepEqual(restarted.map((row: any) => row.id), [other.id]);
    assert.equal(removedRuns, runsBeforeRestart, "removed agents must not resume");
    for (const taskId of [sent.taskId, child.taskId]) {
      const retired = await host.service.harness.getTask(taskId, ctx);
      assert.equal(retired?.state.status, "terminal");
    }
    const replacement = await client.call("agents/new", { name: "parent", cwd: directory, model, requestId: "replacement" });
    assert.notEqual(replacement.id, parent.id);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
