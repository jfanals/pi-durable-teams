import { openPush, watchPush } from "./push.ts";
import { readConfig } from "./config.ts";
import { remoteToken, remoteAllowed, tokenMatches, tokenCache } from "./remote.ts";
import { shellFile, shellCsp, shellPath } from "./web-shell.ts";
import { listDirectories } from "./directories.ts";
import { randomUUID } from "node:crypto";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ActionSchema, type Action } from "./protocol.ts";
import { modelChoices } from "./model-choices.ts";
import { human, openTeams, type TeamsOptions } from "./teams.ts";

const HumanActionSchema = Type.Object({
  ...ActionSchema.properties,
  action: StringEnum(["newAgent", "send", "abort", "stop", "model", "rename", "inspect"]),
  model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
});

// SQLite's OS-backed exclusive lock prevents two hosts opening Durable storage.
// Unlike a PID/heartbeat lock, a crash releases it and a paused process cannot lose it.
export async function startHost(directory: string, socket: string, options: TeamsOptions) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const remotePort = (await readConfig(directory)).remote?.port;
  const owner = new DatabaseSync(join(directory, "owner.sqlite"));
  try { owner.exec("BEGIN EXCLUSIVE"); }
  catch { owner.close(); throw new Error("A Durable teams host already owns this directory"); }
  let service: Awaited<ReturnType<typeof openTeams>> | undefined;
  let push: ReturnType<typeof openPush> | undefined;
  let pushWatch: ReturnType<typeof watchPush> | undefined;
  const streams = new Map<string, ServerResponse>();
  const workerStreams = new Set<ServerResponse>();
  const remoteStreams = new Set<ServerResponse>();
  const credentials = tokenCache(directory, () => { for (const res of remoteStreams) res.destroy(); });
  let tokenTimer: ReturnType<typeof setInterval> | undefined;
  const cleanups = new Set<() => unknown>();
  const connectionsChanged = new Set<() => void>();
  const notifyConnections = () => { for (const listener of connectionsChanged) listener(); };
  async function frame(res: ServerResponse, value: unknown) {
    if (res.destroyed || res.write(`${JSON.stringify(value)}\n`)) return;
    // A large frame is not a failed client. Honor backpressure; Durable coalesces
    // a slow worker watch to a fresh change tick instead of accumulating events.
    await new Promise<void>(resolve => {
      const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
      res.once("drain", done); res.once("close", done);
    });
  }
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  };
  const handler = (remote: boolean): import("node:http").RequestListener => async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      if (pathname !== (req.url ?? "/").split("?")[0]) return reply(res, 404, { error: "Unknown operation" });
      if (shellPath(pathname)) res.setHeader("content-security-policy", shellCsp);
      if (remote) {
        const allowed = remoteAllowed(pathname);
        if (!allowed || (allowed === "shell" && req.method !== "GET")) return reply(res, 404, { error: "Unknown operation" });
        // App files are public static code (manifest, icons, scripts): Chrome's installer fetches them
        // without credentials. Everything with agent data or actions is an API route and needs the token.
        if (allowed === "api") {
          const { token, error } = credentials.get();
          if (error) return reply(res, 503, { error: `remote disabled: ${error}` });
          const supplied = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ?? "";
          if (!tokenMatches(token, supplied)) return reply(res, 401, { error: "Unauthorized: Bearer token required for API requests" });
        }
        remoteStreams.add(res);
        res.once("close", () => remoteStreams.delete(res));
      }
      if (req.method === "GET") {
        const file = await shellFile(pathname);
        if (file) {
          res.writeHead(200, { "content-type": file.type, "cache-control": "no-store", "referrer-policy": "no-referrer", "service-worker-allowed": "/", "x-content-type-options": "nosniff" });
          res.end(file.body); return;
        }
      }
      if (pathname === "/health") return reply(res, 200, { pid: process.pid, ready: Boolean(service) });
      if (!service) return reply(res, 503, { error: "Host starting" });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error("Request exceeds 2 MiB");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (pathname === "/register") return reply(res, 200, await service.register(body));
      if (pathname.startsWith("/agents/push/")) {
        if (!push) return reply(res, 503, { error: "Web Push unavailable; see host log" });
        if (pathname === "/agents/push/key" && req.method === "POST") return reply(res, 200, { publicKey: push.publicKey });
        if (pathname === "/agents/push/subscribe" && req.method === "POST") {
          push.subscribe(body.subscription); pushWatch?.schedule();
          return reply(res, 200, { subscribed: true });
        }
        if (pathname === "/agents/push/unsubscribe" && req.method === "POST") {
          push.unsubscribe(body.endpoint); pushWatch?.schedule();
          return reply(res, 200, { subscribed: false });
        }
        return reply(res, 404, { error: "Unknown push operation" });
      }
      // Local human clients are authenticated by the private socket directory.
      if (pathname === "/agents/models") {
        const all = async () => modelChoices(await (typeof options.models === "function" ? options.models() : options.models).getAvailable());
        return reply(res, 200, await (options.availableModels ?? all)());
      }
      if (pathname === "/agents/defaults") return reply(res, 200, await options.agentModel?.() ?? null);
      if (pathname === "/agents/dirs") {
        if (body.path !== undefined && typeof body.path !== "string") throw new Error("path must be a string");
        return reply(res, 200, await listDirectories(body.path));
      }
      if (pathname === "/agents") return reply(res, 200, await service!.agents());
      if (pathname === "/agents/roster") {
        res.writeHead(200, { "content-type": "application/x-ndjson" }); res.flushHeaders();
        workerStreams.add(res);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let running = false; let dirty = false; let stopped = false;
        let previous = "";
        const flush = async () => {
          timer = undefined;
          if (running || stopped) return;
          running = true;
          try {
            while (dirty && !stopped) {
              dirty = false;
              const rows = await service!.agents();
              const json = JSON.stringify(rows);
              if (json !== previous) { previous = json; await frame(res, rows); }
            }
          } catch (error) { res.destroy(error as Error); }
          finally { running = false; }
        };
        const schedule = () => {
          dirty = true;
          if (!timer && !running && !stopped) timer = setTimeout(() => { void flush(); }, 25);
        };
        const unsubscribe = service.subscribe(schedule);
        connectionsChanged.add(schedule);
        const stop = () => {
          stopped = true; clearTimeout(timer); unsubscribe(); connectionsChanged.delete(schedule);
          workerStreams.delete(res); cleanups.delete(stop);
        };
        cleanups.add(stop); res.on("close", stop);
        schedule();
        return;
      }
      if (pathname === "/agents/remove") {
        if (req.method !== "POST") return reply(res, 405, { error: "POST required" });
        if (typeof body.target !== "string" || !body.target) throw new Error("target is required");
        if (typeof body.requestId !== "string" || !body.requestId) throw new Error("requestId is required");
        return reply(res, 200, await service.remove(body.target, body.requestId));
      }
      if (pathname === "/agents/compact") {
        if (req.method !== "POST") return reply(res, 405, { error: "POST required" });
        if (typeof body.target !== "string" || !body.target) throw new Error("target is required");
        if (body.instructions !== undefined && typeof body.instructions !== "string") throw new Error("instructions must be a string");
        return reply(res, 200, await service.compact(body.target, body.instructions));
      }
      if (pathname === "/agents/inputs") {
        if (req.method !== "POST") return reply(res, 405, { error: "POST required" });
        if (typeof body.target !== "string" || !body.target) throw new Error("target is required");
        return reply(res, 200, await service.inputs(body.target));
      }
      if (pathname === "/agents/fork") {
        if (req.method !== "POST") return reply(res, 405, { error: "POST required" });
        if (typeof body.target !== "string" || !body.target) throw new Error("target is required");
        if (typeof body.requestId !== "string" || !body.requestId) throw new Error("requestId is required");
        if (body.before !== undefined && (typeof body.before !== "string" || !/^\d+$/.test(body.before))) throw new Error("before must be an entry ID");
        return reply(res, 200, await service.fork(body.target, body.requestId, body.before));
      }
      if (pathname.startsWith("/agents/") && pathname !== "/agents/watch") {
        const verbs: Record<string, Action["action"]> = { new: "newAgent", send: "send", stop: "abort", disable: "stop", model: "model", rename: "rename", page: "inspect" };
        const route = pathname.slice("/agents/".length);
        const verb = verbs[route];
        if (!verb) return reply(res, 404, { error: "Unknown operation" });
        if (route !== "new" && typeof body.target !== "string") throw new Error("target is required");
        if (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId)) throw new Error("requestId must be a nonempty string");
        const args = { action: verb, target: body.target, name: body.name, cwd: body.cwd, message: body.message, mode: body.mode,
          model: route === "model" ? { provider: body.provider, modelId: body.modelId } : body.model,
          thinking: body.thinking, cursor: body.cursor, ...(route === "page" ? { transcript: true } : {}) };
        if (!Value.Check(HumanActionSchema, args)) throw new Error("Invalid agent action arguments");
        if (route === "page") {
          return reply(res, 200, await service.page(human, body.target, body.cursor));
        }
        return reply(res, 200, await service.action(human, args as Action, body.requestId ?? randomUUID()));
      }
      const actor = pathname === "/agents/watch" ? human : await service.authenticate(body.sessionId, body.secret);
      switch (pathname) {
        case "/action": {
          if (!Value.Check(ActionSchema, body.args)) throw new Error("Invalid team action arguments");
          const controller = new AbortController();
          const closed = () => controller.abort(new Error("Client disconnected"));
          res.once("close", closed);
          let result;
          try { result = await service.action(actor, body.args, body.requestId, controller.signal); }
          finally { res.off("close", closed); }
          return reply(res, 200, body.args.action === "list" && Array.isArray(result)
            ? result.map(agent => agent.role === "main" && !agent.hosted ? { ...agent, connected: streams.has(agent.id) } : agent)
            : result);
        }
        case "/page": {
          if (typeof body.target !== "string") throw new Error("target is required");
          if (body.cursor !== undefined && typeof body.cursor !== "string") throw new Error("cursor must be a string");
          return reply(res, 200, await service.page(actor, body.target, body.cursor));
        }
        case "/ack": await service.ack(actor, body.id); return reply(res, 200, { acknowledged: body.id });
        case "/publish": await service.publish(actor, String(body.latest)); return reply(res, 200, { published: true });
        case "/resume": await service.resume(actor); return reply(res, 200, { resumed: true });
        case "/events": {
          if (streams.has(actor.id)) throw new Error("This main session already has a connected client; close it before reconnecting");
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.flushHeaders();
          streams.set(actor.id, res);
          notifyConnections();
          const sent = new Set<string>();
          let running = false;
          let dirty = false;
          const flush = async () => {
            dirty = true;
            if (running) return;
            running = true;
            try {
              while (dirty && !res.destroyed) {
                dirty = false;
                for (const delivery of await service!.pending(actor)) {
                  if (sent.has(delivery.id)) continue;
                  sent.add(delivery.id);
                  await frame(res, { delivery });
                  if (res.destroyed) break;
                }
              }
            } catch (error) { res.destroy(error as Error); }
            finally { running = false; }
          };
          const unsubscribe = service.subscribe(() => { void flush(); });
          res.on("close", () => { unsubscribe(); if (streams.get(actor.id) === res) streams.delete(actor.id); notifyConnections(); });
          await flush();
          return;
        }
        case "/agents/watch":
        case "/watch": {
          if (typeof body.target !== "string") throw new Error("target is required");
          // Resolve before headers; coalesce changes even when a client is slow.
          let timer: ReturnType<typeof setTimeout> | undefined;
          let running = false; let dirty = false; let stopped = false; let ready = false;
          const flush = async () => {
            timer = undefined;
            if (running || stopped) return;
            running = true; dirty = false;
            try { await frame(res, { changed: true }); }
            catch (error) { res.destroy(error as Error); }
            finally { running = false; if (dirty) schedule(); }
          };
          const schedule = () => {
            dirty = true;
            if (!timer && !running && !stopped && ready) timer = setTimeout(() => { void flush(); }, 25);
          };
          const unsubscribe = await service.watch(actor, body.target, schedule);
          const stop = async () => { stopped = true; clearTimeout(timer); await unsubscribe(); };
          if (res.destroyed) { await stop(); return; }
          res.writeHead(200, { "content-type": "application/x-ndjson" }); res.flushHeaders();
          ready = true; schedule();
          workerStreams.add(res); cleanups.add(stop);
          res.on("close", () => { workerStreams.delete(res); cleanups.delete(stop); void stop(); });
          return;
        }
        default: return reply(res, 404, { error: "Unknown operation" });
      }
    } catch (error) {
      if (res.headersSent) res.destroy(error as Error);
      else reply(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const server = createServer(handler(false));
  const remoteServer = remotePort ? createServer(handler(true)) : undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(tokenTimer);
    for (const res of [...streams.values(), ...workerStreams]) res.destroy();
    server.close(); server.closeAllConnections();
    remoteServer?.close(); remoteServer?.closeAllConnections();
    for (const cleanup of cleanups) await cleanup();
    await service?.close();
    rmSync(socket, { force: true });
    owner.close();
  };
  try {
    // Only the exclusive owner may remove a socket left by a crash.
    rmSync(socket, { force: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    chmodSync(socket, 0o600);
    service = await openTeams(await openNodeSqliteStorage(join(directory, "teams.sqlite")), options);
    try {
      push = openPush(directory);
      pushWatch = watchPush(push, service);
      cleanups.add(pushWatch.close);
    } catch (error) { console.error("Web Push disabled:", error); }
    if (remoteServer) {
      // A corrupt stored token disables remote requests, not the trusted socket.
      await remoteToken(directory).catch(() => {});
      await credentials.refresh();
      tokenTimer = setInterval(() => { void credentials.refresh(); }, 1000);
      await new Promise<void>((resolve, reject) => { remoteServer.once("error", error => reject(new Error(`Cannot listen on remote.port ${remotePort} in config.json: ${error.message}`))); remoteServer.listen(remotePort, "127.0.0.1", resolve); });
    }
    return { service, close };
  } catch (error) { await close(); throw error; }
}
