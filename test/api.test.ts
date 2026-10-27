import { createServer } from "node:net";
import { pair, remoteToken, readRemoteToken, tokenMatches } from "../src/remote.ts";
import { readConfig } from "../src/config.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { createServer as httpsServer, globalAgent } from "node:https";
import { createRequire } from "node:module";
import { formatDuration } from "../src/status.ts";
import { createECDH, randomBytes } from "node:crypto";
import { finished, openPush } from "../src/push.ts";
import { mkdtemp, rm, mkdir, writeFile, stat, chmod, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSummary } from "../src/protocol.ts";
import { Client } from "../src/client.ts";
import { human } from "../src/teams.ts";
import { chatItems } from "../src/chat.ts";
import { startHost } from "../src/host.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
    assert.deepEqual(await source.defaults(), model);
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
    let ticks = 0;
    observe(source.watch(target, life.signal, frame => { assert.deepEqual(frame, { changed: true }); ticks++; }));
    await until(() => ticks > 0);
    const sent = await source.send(target, "DELEGATE", "followUp", { requestId: "send" });
    assert.deepEqual(await source.send(target, "DELEGATE", "followUp", { requestId: "send" }), sent);
    await until(() => frames.some(rows => rows.some(row => row.id === target && row.running)));
    await until(() => roster[0]?.children.length === 1 && !roster[0]?.running && !roster[0]?.children[0]?.running);
    assert.ok(ticks > 1);
    assert.ok(frames.some(rows => rows.some(row => row.activity)));
    const child = roster[0]!.children[0]!;
    await source.send(child.id, "Human input", "steer");
    await until(async () => JSON.stringify(await source.page(child.id)).includes("Human input"));
    const page = await source.page(target);
    assert.ok(page.items.some(item => item.kind === "input"));
    const called = page.items.find(item => item.kind === "reply" && item.parts.some(part => part.type === "tool"));
    assert.ok(called?.kind === "reply");
    const tool = called.parts.find(part => part.type === "tool")!;
    assert.equal(tool.name, "team");
    assert.ok(page.items.some(item => item.kind === "result" && item.callId === tool.id && item.ok));
    assert.ok(page.items.some(item => item.kind === "reply" && item.turn && item.at));
    if (page.next) await source.page(target, page.next);
    const bound = workerSource(source, target);
    assert.equal((await bound.status()).id, target);
    assert.ok((await bound.page()).items.length > 0);
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
    observe(client.stream("events", identity, life.signal, () => {}));
    assert.ok((await source.send(identity.sessionId, "Hello Pi")).delivery);
    assert.match(JSON.stringify(await source.page(identity.sessionId)), /Published observation/);
    assert.deepEqual(await client.call("page", { ...identity, target: identity.sessionId }), await source.page(identity.sessionId));
    await assert.rejects(client.call("action", { ...identity, args: { action: "inspect", target: identity.sessionId, transcript: true } }), /External Pi sessions do not have hosted transcripts/);
    await assert.rejects(source.rename(identity.sessionId, "no"), /cannot be renamed/);
    for (const route of ["agents/watch", "watch"] as const) {
      let tick = false;
      observe(client.stream(route, { ...identity, target: identity.sessionId }, life.signal, value => { assert.deepEqual(value, { changed: true }); tick = true; }));
      await until(() => tick);
    }
    // GET is available as well as the typed client's POST list.
    const get = await new Promise<AgentSummary[]>((resolve, reject) => {
      const req = request({ socketPath: socket, path: "/agents?refresh=1", method: "GET" }, res => {
        let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(JSON.parse(text)));
      }); req.on("error", reject); req.end();
    });
    assert.deepEqual(get.map(row => row.id), [target]);
    await assert.rejects(client.call("agents/send", { target, message: "bad mode", mode: "wrong" }), /Invalid/);
  } finally {
    life.abort(); await Promise.all(streams); await host.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("phone primitives: directory listings, remote config, token auth and socket trust", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-phone-"));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const socket = join(directory, "s");
  const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    for (const remote of [null, {}, { port: 0 }, { port: -1 }, { port: 65536 }, { port: 1.5 }, { port: "1234" }]) {
      await writeFile(join(directory, "config.json"), JSON.stringify({ remote }));
      await assert.rejects(readConfig(directory), /remote must/);
    }
    await writeFile(join(directory, "config.json"), JSON.stringify({ remote: { port } }));
    assert.equal((await readConfig(directory)).remote?.port, port);
    host = await startHost(directory, socket, { models });
    const token = await remoteToken(directory);
    assert.equal((await stat(join(directory, "remote-token"))).mode & 0o777, 0o600);
    const call = async (path: string, options?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, options);
    assert.equal((await call("/health")).status, 401);
    assert.equal((await call("/agents/push/key")).status, 401);
    assert.equal((await call(`/agents/push/key?token=${token}`)).status, 401);
    const pushKey = await call("/agents/push/key", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(pushKey.status, 200);
    assert.equal(typeof (await pushKey.json() as any).publicKey, "string");
    assert.equal((await call("/agents", { headers: { authorization: `Bearer ${"x".repeat(token.length)}` } })).status, 401);
    assert.equal((await call("/agents?token=wrong")).status, 401);
    assert.equal((await call("/agents", { headers: { authorization: token } })).status, 401);
    assert.equal((await call("/health", { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await call(`/agents?token=${token}`)).status, 401);
    // App files are public static code so Chrome can install the app; they carry no agent data.
    const shell = await call("/");
    assert.equal(shell.status, 200); assert.match(shell.headers.get("content-type")!, /text\/html/);
    assert.match(await shell.text(), /Pi Agents/);
    assert.equal(shell.headers.get("set-cookie"), null);
    assert.match(shell.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    for (const path of ["/web/manifest.webmanifest", "/web/icons/icon-192.png", "/web/icons/icon-512.png", "/web/sw.js"]) assert.equal((await call(path)).status, 200, path);
    assert.equal((await call("/web/main.ts", { method: "POST" })).status, 404, "shell files are GET only");
    assert.equal((await call(`/agents?token=${token}`, { headers: { cookie: `pi_shell=${token}` } })).status, 401, "API needs the Bearer header");
    for (const path of ["/web/main.ts", "/status.ts", "/agent-name.ts"]) {
      const module = await call(path);
      assert.equal(module.status, 200); assert.match(module.headers.get("content-type")!, /javascript/);
      const code = await module.text(); assert.doesNotMatch(code, /export type |: WorkerStatus|: string/);
    }
    const marked = await call("/web/marked.js");
    assert.equal(marked.status, 200); assert.match(marked.headers.get("content-type")!, /javascript/);
    assert.match(await marked.text(), /export/);
    for (const path of ["/web/nope.ts", "/host.ts", "/web/../host.ts", "/web/%2e%2e/host.ts", "/web/%2f..%2fhost.ts", "/node_modules/marked/lib/marked.esm.js"]) {
      assert.equal((await call(`${path}?token=${token}`)).status, 404, path);
    }
    const allowed = await call("/agents", { headers: { authorization: `Bearer ${token}` } }); assert.equal(allowed.status, 200); assert.deepEqual(await allowed.json(), []);
    for (const path of ["/register", "/action", "/events", "/ack", "/publish", "/resume", "/watch", "/page", "/agents-other"]) {
      assert.equal((await call(`${path}?token=${token}`, { method: "POST", body: "{}" })).status, 404, path);
    }
    const client = new Client(socket);
    assert.equal((await client.call("health")).ready, true);
    const identity = { sessionId: "external", secret: "s".repeat(36) };
    await client.call("register", { ...identity, name: "Pi", cwd: directory, model: { provider: "faux", modelId: "faux-1" } });
    assert.deepEqual(await (await call("/agents", { headers: { authorization: `Bearer ${token}` } })).json(), [], "external sessions are absent from the human roster");
    const source = new SocketHostSource(client);
    assert.equal(await source.defaults(), null);
    const remoteDefaults = await call("/agents/defaults", { headers: { authorization: `Bearer ${token}` }, method: "POST", body: "{}" });
    assert.equal(remoteDefaults.status, 200); assert.equal(await remoteDefaults.json(), null);
    assert.equal((await call("/agents/defaults", { method: "POST", body: "{}" })).status, 401);
    assert.deepEqual((await source.page(identity.sessionId)).items, [{ id: "publication", kind: "notice", text: "This Pi session has no hosted transcript." }]);
    await client.call("publish", { ...identity, latest: "Latest \x1b[31mpublication\x1b[0m\x07" });
    assert.deepEqual((await source.page(identity.sessionId)).items, [{ id: "publication", kind: "reply", parts: [{ type: "text", text: "Latest publication" }] }]);
    const parent = join(directory, "folders");
    await mkdir(join(parent, "Zoo", ".git"), { recursive: true });
    await mkdir(join(parent, "alpha")); await mkdir(join(parent, "node_modules"));
    await writeFile(join(parent, "Zoo", "AGENTS.md"), "Instructions");
    const listing = await client.call("agents/dirs", { path: parent });
    assert.equal(listing.path, parent); assert.equal(listing.parent, directory);
    assert.deepEqual(listing.dirs, [{ name: "alpha", markers: "" }, { name: "Zoo", markers: "git · AGENTS.md" }]);
    const remoteListing = await call("/agents/dirs", { headers: { authorization: `Bearer ${token}` }, method: "POST", body: JSON.stringify({ path: parent }) });
    assert.deepEqual(await remoteListing.json(), listing);
    assert.match((await client.call("agents/dirs", { path: join(parent, "missing") })).error, /Cannot read/);
    assert.ok((await client.call("agents/dirs")).path);
    await assert.rejects(client.call("agents/dirs", { path: "relative" }), /absolute/);
    const relative = await call("/agents/dirs", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ path: "relative" }) });
    assert.equal(relative.status, 400);
    const stream = await call("/agents/roster", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const reader = stream.body!.getReader();
    await reader.read();
    const ended = (async () => { try { while (!(await reader.read()).done) {} } catch { /* destroyed by rotation */ } })();
    const rotated = await remoteToken(directory, true); assert.notEqual(rotated, token);
    assert.equal((await call(`/health?token=${token}`)).status, 401);
    await Promise.race([ended, delay(3000).then(() => assert.fail("Rotated stream remained open"))]);
    assert.equal((await call("/health", { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await call("/health", { headers: { authorization: `Bearer ${rotated}` } })).status, 200);
    for (const invalid of ["", "short"]) {
      await writeFile(join(directory, "remote-token"), invalid);
      await until(async () => (await call("/agents", { headers: { authorization: `Bearer ${rotated}` } })).status === 503);
      const disabled = await call(`/agents?token=${invalid}`);
      assert.equal(disabled.status, 503);
      assert.match((await disabled.json() as any).error, /remote disabled:.*at least 32/);
    }
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("pair prints a tailnet URL, optional QR and serve instructions without running serve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-pair-"));
  const oldPath = process.env.PATH; const log = console.log; const output: string[] = [];
  console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
  try {
    await assert.rejects(pair(directory), /Set "remote".*"port"/);
    await writeFile(join(directory, "config.json"), JSON.stringify({ remote: { port: 8787 } }));
    const calls = join(directory, "calls");
    await writeFile(join(directory, "tailscale"), `#!/bin/sh\necho "$*" >> '${calls}'\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"machine.tail.ts.net."}}'; else echo '{}'; fi\n`);
    await writeFile(join(directory, "qrencode"), '#!/bin/sh\nprintf "QR %s" "$*"\n');
    await chmod(join(directory, "tailscale"), 0o700); await chmod(join(directory, "qrencode"), 0o700);
    process.env.PATH = directory;
    await pair(directory);
    const token = await remoteToken(directory);
    assert.match(output[0]!, /^Run: tailscale serve --bg 8787 /);
    assert.equal(output[1], `https://machine.tail.ts.net/?token=${token}`);
    assert.match(output[2]!, /^QR -t ansiutf8 https:/);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["serve status --json", "status --json"]);
    // Serve already proxies this port on 8443: that exact address is printed, no setup hint.
    await writeFile(join(directory, "tailscale"), `#!/bin/sh\necho '{"Web":{"machine.tail.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}'\n`);
    output.length = 0; await pair(directory);
    assert.equal(output[0], `https://machine.tail.ts.net:8443/?token=${token}`);
    assert.ok(!output.some(line => line.startsWith("Run:")));
    await rm(join(directory, "tailscale")); await rm(join(directory, "qrencode"));
    output.length = 0; await pair(directory, true);
    assert.match(output[0]!, /^http:\/\/127\.0\.0\.1:8787\/\?token=/);
    assert.notEqual(await remoteToken(directory), token);
    assert.equal(output.length, 1); // no Tailscale, no QR tool: just the local URL
  } finally { console.log = log; process.env.PATH = oldPath; await rm(directory, { recursive: true, force: true }); }
});


test("token creation is atomic across competing creators and rejects short stored credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-token-"));
  try {
    const tokens = await Promise.all(Array.from({ length: 32 }, () => remoteToken(directory)));
    assert.ok(tokens.every(token => token.length === 64 && token === tokens[0]));
    assert.deepEqual(await readdir(directory), ["remote-token"]);
    assert.equal((await stat(join(directory, "remote-token"))).mode & 0o777, 0o600);
    for (const token of ["", "short", "x".repeat(31)]) {
      await writeFile(join(directory, "remote-token"), token);
      await assert.rejects(readRemoteToken(directory), /at least 32/);
      await assert.rejects(remoteToken(directory), /at least 32/);
      assert.equal(tokenMatches(token, token), false);
      assert.equal(tokenMatches(tokens[0]!, token), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("host reads prefix chunks to complete a turn spanning transcript pages", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-page-"));
  const fake = fauxProvider({ tokensPerSecond: 100000 });
  fake.setResponses([
    ...Array.from({ length: 45 }, () => fauxAssistantMessage(fauxToolCall("team", { action: "list" }), { stopReason: "toolUse" })),
    fauxAssistantMessage("Complete request"),
  ]);
  const models = createModels(); models.setProvider(fake.provider);
  const socket = join(directory, "s");
  const host = await startHost(directory, socket, { models, agentModel: async () => ({ provider: "faux", modelId: "faux-1" }) });
  try {
    const source = new SocketHostSource(new Client(socket));
    const agent = await source.newAgent({ name: "long", cwd: directory });
    await source.send(agent.id!, "Run a long request");
    await until(async () => JSON.stringify(await source.page(agent.id!)).includes("Complete request"));
    const raw = await host.service.action(human, { action: "inspect", target: agent.id, transcript: true }, "") as any;
    assert.equal(raw.entries.length, 40);
    assert.equal(Object.hasOwn(raw, "prefix"), false);
    assert.ok(raw.next);
    const entries = [...raw.entries];
    let cursor = raw.next;
    while (cursor) {
      const older = await host.service.action(human, { action: "inspect", target: agent.id, transcript: true, cursor }, "") as any;
      assert.equal(Object.hasOwn(older, "prefix"), false);
      assert.ok(older.entries.every((entry: any) => !entries.some(previous => previous.id === entry.id)));
      entries.push(...older.entries);
      cursor = older.next;
    }
    assert.ok(entries.length > 80);
    const client = new Client(socket);
    const identity = { sessionId: "reader", secret: "s".repeat(36) };
    await client.call("register", { ...identity, name: "Reader", cwd: directory, model: { provider: "faux", modelId: "faux-1" } });
    await assert.rejects(client.call("page", { ...identity, secret: "bad", target: agent.id }), /identity\/secret/);
    const page = await client.call("page", { ...identity, target: agent.id });
    assert.deepEqual(page, await source.page(agent.id!));
    const items = page.items as Awaited<ReturnType<typeof source.page>>["items"];
    const expected = chatItems(entries);
    const terminal = items.find(item => item.kind === "reply" && item.turn);
    assert.ok(terminal?.kind === "reply");
    assert.deepEqual(terminal.turn, expected.find(item => item.id === terminal.id && item.kind === "reply")?.kind === "reply"
      ? (expected.find(item => item.id === terminal.id) as any).turn : undefined);
    assert.ok(items.every(item => raw.entries.some((entry: any) => String(entry.id) === item.id)));
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("busy remote listener identifies remote.port and its configured port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-port-"));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  try {
    await writeFile(join(directory, "config.json"), JSON.stringify({ remote: { port } }));
    const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
    await assert.rejects(startHost(directory, join(directory, "s"), { models }), new RegExp(`remote.port ${port} in config.json`));
  } finally { await new Promise<void>(resolve => reservation.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

function pushSubscription(endpoint: string) {
  const key = createECDH("prime256v1"); key.generateKeys();
  return { privateKey: key, subscription: { endpoint, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } } };
}

test("finished ignores initial frames, children, external agents, unchanged idle and missing rows", () => {
  const row = (id: string, running: boolean, hosted = true, children: AgentSummary[] = []): AgentSummary => ({ id, name: id, running, hosted, children, enabled: true });
  const before = [row("lead", true, true, [row("child", true)]), row("pi", true, false)];
  const after = [row("lead", false, true, [row("child", false)]), row("pi", false, false)];
  assert.deepEqual(finished(undefined, after), []);
  assert.deepEqual(finished(before, after).map(a => a.id), ["lead"]);
  assert.deepEqual(finished(after, after), []);
  assert.deepEqual(finished(before, []), []);
  assert.deepEqual(finished([row("lead", false, true, [row("child", true)])], after), []);
});

test("Web Push routes persist subscriptions and send encrypted notifications only for top-level finishes", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-push-")); const socket = join(directory, "s");
  const requests: { headers: import("node:http").IncomingHttpHeaders; body: Buffer }[] = [];
  let status = 201;
  const cert = await readFile(new URL("./fixtures/wp-test-cert.pem", import.meta.url));
  const ca = globalAgent.options.ca; globalAgent.options.ca = cert;
  const endpoint = httpsServer({ cert, key: await readFile(new URL("./fixtures/wp-test-key.pem", import.meta.url)) }, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(status); res.end();
  });
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const { subscription, privateKey } = pushSubscription(`https://127.0.0.1:${(endpoint.address() as import("node:net").AddressInfo).port}/push`);
  const fake = fauxProvider({ tokensPerSecond: 100 });
  fake.setResponses(Array.from({ length: 50 }, () => req => {
    const last = req.messages.findLast(m => m.role !== "system");
    if (last?.role === "user" && JSON.stringify(last).includes("DELEGATE")) return fauxAssistantMessage(fauxToolCall("team", { action: "spawn", name: "reader", message: "Read and report" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("A private transcript answer. ".repeat(4));
  }));
  const models = createModels(); models.setProvider(fake.provider);
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    host = await startHost(directory, socket, { models, agentModel: async () => ({ provider: "faux", modelId: "faux-1" }) });
    const client = new Client(socket); const source = new SocketHostSource(client);
    const key = await client.call("agents/push/key");
    await assert.rejects(client.call("agents/push/subscribe", { subscription: { endpoint: subscription.endpoint } }), /keys/);
    for (const endpoint of ["http://example.com/push", "https://user:pass@example.com/push"]) {
      await assert.rejects(client.call("agents/push/subscribe", { subscription: { ...subscription, endpoint } }), /Invalid push endpoint/);
    }
    await client.call("agents/push/subscribe", { subscription });
    await client.call("agents/push/subscribe", { subscription });
    let stored = JSON.parse(await readFile(join(directory, "push.json"), "utf8"));
    assert.equal(Object.keys(stored.subscriptions).length, 1);
    assert.equal((await stat(join(directory, "push.json"))).mode & 0o777, 0o600);
    assert.equal(openPush(directory).publicKey, key.publicKey);
    assert.equal(openPush(directory).active, true);
    const agent = await source.newAgent({ name: "lead", cwd: directory });
    await delay(100); assert.equal(requests.length, 0, "initial idle snapshot is silent");
    await source.send(agent.id!, "DELEGATE");
    await until(() => requests.length === 1);
    await until(async () => { const rows = await source.list(); return !rows[0]?.running && rows[0]?.children.length === 1 && !rows[0]?.children[0]?.running; });
    await delay(150);
    assert.equal(requests.length, 1, "child completion and later idle frames are silent");
    assert.equal(requests[0]!.headers["content-encoding"], "aes128gcm");
    assert.match(String(requests[0]!.headers.authorization), /^vapid t=.+, k=.+/);
    assert.equal(requests[0]!.headers.ttl, "3600"); assert.equal(requests[0]!.headers.urgency, "normal");
    assert.ok(requests[0]!.body.length > 86);
    assert.ok(!requests[0]!.body.includes(Buffer.from("private transcript")));
    // The fixture retains the receiver key; decrypt the real wire payload.
    const ece = createRequire(import.meta.url)("http_ece");
    const plaintext = ece.decrypt(requests[0]!.body, { version: "aes128gcm", privateKey, authSecret: subscription.keys.auth });
    const completed = (await source.list()).find(row => row.id === agent.id)!;
    assert.deepEqual(JSON.parse(plaintext.toString()), {
      title: "lead finished",
      body: [completed.model, formatDuration(completed.finishedAt! - completed.since!)].filter(Boolean).join(" · "),
      agent: agent.id,
    });
    assert.ok(!plaintext.includes(Buffer.from("private transcript")));
    await host.close(); host = undefined;
    host = await startHost(directory, socket, { models, agentModel: async () => ({ provider: "faux", modelId: "faux-1" }) });
    await delay(150); assert.equal(requests.length, 1, "host reconnect first snapshot is silent");
    assert.deepEqual(await client.call("agents/push/key"), key);
    status = 500;
    await openPush(directory).send(completed);
    assert.equal(requests.length, 2);
    assert.equal(openPush(directory).active, true, "transient endpoint failures retain subscriptions");
    status = 410;
    await source.send(agent.id!, "Another request");
    await until(() => requests.length === 3);
    await until(async () => Object.keys(JSON.parse(await readFile(join(directory, "push.json"), "utf8")).subscriptions).length === 0);
    await client.call("agents/push/subscribe", { subscription });
    await client.call("agents/push/unsubscribe", { endpoint: subscription.endpoint });
    stored = JSON.parse(await readFile(join(directory, "push.json"), "utf8"));
    assert.deepEqual(stored.subscriptions, {});
    assert.equal(openPush(directory).active, false);
  } finally {
    globalAgent.options.ca = ca;
    await host?.close(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued messages, /compact and Pi's cache-miss notices", { timeout: 15000 }, async () => {
  // Pi's own detection and wording: a 60k re-bill after 12 idle minutes; a small miss stays silent.
  const { cacheMissText, piCacheMisses } = await import("../src/presentation.ts");
  const { formatTokens } = await import("../src/status.ts");
  const usage = (input: number, cacheRead: number) => ({ input, output: 10, cacheRead, cacheWrite: 0, cost: { input: input * 3e-6, output: 0, cacheRead: cacheRead * 3e-7, cacheWrite: 0, total: 0 } });
  const reply = (timestamp: number, input: number, cacheRead: number) => ({ type: "message", message: { role: "assistant", provider: "p", model: "m", timestamp, usage: usage(input, cacheRead) } });
  const collect = await piCacheMisses();
  const misses = [...collect([reply(0, 1000, 60_000), reply(12 * 60_000, 61_000, 0), reply(12 * 60_000 + 1, 1000, 61_500)], { getModel: () => undefined }).values()];
  assert.equal(misses.length, 1);
  assert.equal(cacheMissText(misses[0]!, formatTokens), "Cache miss after 12m idle: 61k tokens re-billed (~$0.18)");
  assert.equal(cacheMissText({ missedTokens: 5000, missedCost: 0.01, idleMs: 0, modelChanged: false }, formatTokens), undefined);

  const directory = await mkdtemp(join(tmpdir(), "agents-queue-"));
  const fake = fauxProvider({ tokensPerSecond: 50 });
  fake.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("Working slowly. ".repeat(40))));
  const models = createModels(); models.setProvider(fake.provider);
  const socket = join(directory, "s");
  const host = await startHost(directory, socket, { models, agentModel: async () => ({ provider: "faux", modelId: "faux-1" }), showCacheMissNotices: () => true });
  try {
    const source = new SocketHostSource(new Client(socket));
    const agent = await source.newAgent({ name: "busy", cwd: directory });
    await source.send(agent.id!, "Start");
    await until(async () => (await source.list()).some(row => row.id === agent.id && row.running));
    // Pi shows waiting input above its editor; the page carries it, oldest first, by mode.
    await source.send(agent.id!, "Steer this way", "steer");
    await source.send(agent.id!, "Then this\nsecond line", "followUp");
    const queued = (await source.page(agent.id!)).queued;
    assert.deepEqual(queued, [{ mode: "steer", text: "Steer this way" }, { mode: "followUp", text: "Then this" }]);
    await source.stop(agent.id!);
    await until(async () => !(await source.list()).find(row => row.id === agent.id)?.running);
    assert.deepEqual((await source.page(agent.id!)).queued, []);
    // /compact starts Durable's manual compaction; with too little history it completes without a summary.
    const compacted = await source.compact(agent.id!, "keep decisions") as { taskId?: number };
    assert.equal(typeof compacted.taskId, "number");
    await host.service.harness.waitForTask(compacted.taskId as any, BACKGROUND_CONTEXT);
    await assert.rejects(source.compact("missing"), /No accessible agent/);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
