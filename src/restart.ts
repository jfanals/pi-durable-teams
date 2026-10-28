import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "./client.ts";
import { stateDir } from "./paths.ts";

type Health = { pid: number; ready: boolean; entry?: string };
const health = (client: Client) => client.call<Health>("health").catch(() => undefined);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// `pi-agents restart-host`: the work runs in a detached process, so it finishes even when the
// caller is an agent inside the host being restarted. The caller only watches for the new host.
export async function restartHost(client = new Client()) {
  const old = await health(client);
  const log = join(stateDir, "host.log");
  const fd = openSync(log, "a", 0o600);
  spawn(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), String(old?.pid ?? 0)], { detached: true, stdio: ["ignore", fd, fd] }).unref();
  closeSync(fd);
  console.log(old ? `Stopping host ${old.pid}…` : "No host running; starting one…");
  for (let i = 0; i < 1800; i++) {
    await delay(100);
    const now = await health(client);
    if (now?.ready && now.pid !== old?.pid) { console.log(`Host ${now.pid} running ${now.entry}`); return; }
  }
  throw new Error(`The host did not come back within 3 minutes; see ${log}`);
}

async function detached(oldPid: number) {
  const stamp = () => new Date().toISOString();
  if (oldPid) {
    console.error(`${stamp()} restart-host: SIGTERM ${oldPid}`);
    try { process.kill(oldPid, "SIGTERM"); } catch {}
    for (let i = 0; alive(oldPid); i++) {
      if (i === 1200) { console.error(`${stamp()} restart-host: ${oldPid} still running after 2 minutes; not starting another host`); process.exit(1); }
      await delay(100);
    }
  }
  // Open clients may already have started the new host; ensureHost then simply finds it.
  await new Client().ensureHost();
  console.error(`${stamp()} restart-host: host ${(await health(new Client()))?.pid} ready`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await detached(Number(process.argv[2]));
