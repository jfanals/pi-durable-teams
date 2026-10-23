import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ActionSchema } from "./protocol.ts";
import { openTeams, type TeamsOptions } from "./teams.ts";

// SQLite's OS-backed exclusive lock prevents two hosts opening Durable storage.
// Unlike a PID/heartbeat lock, a crash releases it and a paused process cannot lose it.
export async function startHost(directory: string, socket: string, options: TeamsOptions) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const owner = new DatabaseSync(join(directory, "owner.sqlite"));
  try { owner.exec("BEGIN EXCLUSIVE"); }
  catch { owner.close(); throw new Error("A Durable teams host already owns this directory"); }
  let service: Awaited<ReturnType<typeof openTeams>> | undefined;
  const streams = new Map<string, ServerResponse>();
  const workerStreams = new Set<ServerResponse>();
  const cleanups = new Set<() => unknown>();
  async function frame(res: ServerResponse, value: unknown) {
    if (res.destroyed || res.write(`${JSON.stringify(value)}\n`)) return;
    // A large frame is not a failed client. Honor backpressure; Durable coalesces
    // a slow worker watch to a fresh snapshot instead of accumulating events.
    await new Promise<void>(resolve => {
      const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
      res.once("drain", done); res.once("close", done);
    });
  }
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/health") return reply(res, 200, { pid: process.pid, ready: Boolean(service) });
      if (!service) return reply(res, 503, { error: "Host starting" });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error("Request exceeds 2 MiB");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url === "/register") return reply(res, 200, await service.register(body));
      const actor = await service.authenticate(body.sessionId, body.secret);
      switch (req.url) {
        case "/action": {
          if (!Value.Check(ActionSchema, body.args)) throw new Error("Invalid team action arguments");
          const result = await service.action(actor, body.args, body.requestId);
          return reply(res, 200, body.args.action === "list" && Array.isArray(result)
            ? result.map(agent => agent.role === "main" ? { ...agent, connected: streams.has(agent.id) } : agent)
            : result);
        }
        case "/ack": await service.ack(actor, body.id); return reply(res, 200, { acknowledged: body.id });
        case "/publish": await service.publish(actor, String(body.latest)); return reply(res, 200, { published: true });
        case "/resume": await service.resume(actor); return reply(res, 200, { resumed: true });
        case "/events": {
          if (streams.has(actor.id)) throw new Error("This main session already has a connected client; close it before reconnecting");
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.flushHeaders();
          streams.set(actor.id, res);
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
          res.on("close", () => { unsubscribe(); if (streams.get(actor.id) === res) streams.delete(actor.id); });
          await flush();
          return;
        }
        case "/watch": {
          res.writeHead(200, { "content-type": "application/x-ndjson" }); res.flushHeaders();
          workerStreams.add(res);
          const stop = await service.watch(actor, body.target, value => frame(res, value));
          if (res.destroyed) { workerStreams.delete(res); await stop(); return; }
          cleanups.add(stop);
          res.on("close", () => { workerStreams.delete(res); cleanups.delete(stop); void stop(); });
          return;
        }
        default: return reply(res, 404, { error: "Unknown operation" });
      }
    } catch (error) {
      if (res.headersSent) res.destroy(error as Error);
      else reply(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const res of [...streams.values(), ...workerStreams]) res.destroy();
    server.close(); server.closeAllConnections();
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
    return { service, close };
  } catch (error) { await close(); throw error; }
}
