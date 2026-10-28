import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { socketPath, stateDir } from "./paths.ts";

export class Client {
  readonly socket: string;
  constructor(socket = socketPath) { this.socket = socket; }
  call<T = any>(operation: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socket, path: `/${operation}`, method: "POST", signal }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200) reject(new Error(value.error ?? `Host HTTP ${res.statusCode}`));
            else resolve(value);
          } catch (error) { reject(error); }
        });
      });
      const args = operation === "action" ? (body as { args?: { action?: string; timeoutSeconds?: number } }).args : undefined;
      const timeout = args?.action === "wait" ? ((args.timeoutSeconds ?? 600) + 60) * 1000 : 60_000;
      req.setTimeout(timeout, () => req.destroy(new Error("Durable host request timed out; retry only with the same request ID")));
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
  async ensureHost(signal?: AbortSignal) {
    const healthy = async () => {
      try { return (await this.call<{ ready: boolean }>("health", {}, signal)).ready; }
      catch { return false; }
    };
    if (await healthy()) return;
    signal?.throwIfAborted();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const fd = openSync(join(stateDir, "host.log"), "a", 0o600);
    // PI_TEAMS_DAEMON pins which checkout starts the host (pi-agents-dev sets it to the live one).
    const daemon = process.env.PI_TEAMS_DAEMON ?? fileURLToPath(new URL("./daemon.ts", import.meta.url));
    const child = spawn(process.execPath, ["--no-warnings", daemon], {
      detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PI_TEAMS_SOCKET: this.socket },
    });
    closeSync(fd);
    let failure: Error | undefined;
    child.on("error", error => { failure = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      await delay(100, undefined, { signal });
      if (await healthy()) return;
      if (failure) throw failure;
    }
    throw new Error(`Durable host did not start. Inspect ${join(stateDir, "host.log")}; no work was retried by the client.`);
  }
  async stream(operation: "events" | "watch" | "agents/watch" | "agents/roster", body: unknown, signal: AbortSignal, receive: (value: any) => void | Promise<void>) {
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: this.socket, path: `/${operation}`, method: "POST", signal }, async res => {
        try {
          if (res.statusCode !== 200) {
            const chunks = []; for await (const chunk of res) chunks.push(chunk);
            throw new Error(Buffer.concat(chunks).toString());
          }
          let buffered = "";
          res.setEncoding("utf8");
          for await (const chunk of res) {
            buffered += chunk;
            let end: number;
            while ((end = buffered.indexOf("\n")) >= 0) {
              const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
              if (line) await receive(JSON.parse(line));
            }
          }
          resolve();
        } catch (error) { req.destroy(); reject(error); }
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
}
