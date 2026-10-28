import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "../src/client.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/pi-agents.ts", import.meta.url));
const daemon = fileURLToPath(new URL("./fixtures/daemon.ts", import.meta.url));

test("restart-host stops the running host and brings up one from PI_TEAMS_DAEMON", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-restart-"));
  const env = { ...process.env, PI_TEAMS_DIR: directory, PI_TEAMS_SOCKET: join(directory, "s"), PI_TEAMS_DAEMON: daemon };
  const client = new Client(env.PI_TEAMS_SOCKET);
  try {
    // A cold start, then a restart of a running host.
    const first = await run(process.execPath, ["--no-warnings", cli, "restart-host"], { env });
    assert.match(first.stdout, /No host running/);
    const before = await client.call("health");
    assert.equal(before.entry, daemon);
    const second = await run(process.execPath, ["--no-warnings", cli, "restart-host"], { env });
    const after = await client.call("health");
    assert.notEqual(after.pid, before.pid);
    assert.match(second.stdout, new RegExp(`Stopping host ${before.pid}…\\nHost ${after.pid} running`));
    assert.throws(() => process.kill(before.pid, 0));
    assert.match(await readFile(join(directory, "host.log"), "utf8"), new RegExp(`SIGTERM ${before.pid}`));
    process.kill(after.pid, "SIGTERM");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
