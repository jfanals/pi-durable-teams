import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../scripts/migrate.ts";

test("cutover archives only legacy integration, preserves source/history and provider policy", async () => {
  const home = await mkdtemp(join(tmpdir(), "teams-migration-"));
  const agent = join(home, ".pi", "agent");
  try {
    await mkdir(join(agent, "skills", "super-manager"), { recursive: true });
    await mkdir(join(agent, "claude-fleet"), { recursive: true });
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "bin", "fleet"), "old command");
    const settings = { theme: "unchanged", packages: ["/src/pi-spawn", "/some/session-control-default.ts", "npm:sideshow", "npm:pi-cmux"] };
    await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
    await writeFile(join(agent, "claude-fleet", "fleet.sqlite"), "do not touch");
    await writeFile(join(agent, "claude-fleet", "config.json"), JSON.stringify({ allowedProviders: ["test-provider"] }));
    const backup = migrate(home, "/src/pi-durable-teams");
    assert.deepEqual(JSON.parse(await readFile(join(backup, "settings.json"), "utf8")), settings);
    const after = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
    assert.deepEqual(after.packages, ["npm:sideshow", "npm:pi-cmux", "/src/pi-durable-teams"]);
    assert.equal(after.theme, settings.theme);
    assert.match(await readFile(join(home, "bin", "fleet"), "utf8"), /deactivated/);
    assert.equal(await readFile(join(backup, "commands", "fleet"), "utf8"), "old command");
    assert.equal(await readFile(join(agent, "claude-fleet", "fleet.sqlite"), "utf8"), "do not touch");
    assert.deepEqual(JSON.parse(await readFile(join(agent, "durable-teams", "config.json"), "utf8")).allowedProviders, ["test-provider"]);
    assert.throws(() => migrate(home, "/src/pi-durable-teams"), /already configured/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("broken legacy spending policy refuses migration before changing configuration or skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "teams-migration-refuse-")); const agent = join(home, ".pi", "agent");
  try {
    await mkdir(join(agent, "claude-fleet"), { recursive: true });
    await writeFile(join(agent, "settings.json"), '{"packages":["/src/pi-spawn"]}');
    await writeFile(join(agent, "claude-fleet", "config.json"), '{"allowedProviders":"all"}');
    assert.throws(() => migrate(home, "/src/new"), /Invalid old provider policy/);
    assert.equal(await readFile(join(agent, "settings.json"), "utf8"), '{"packages":["/src/pi-spawn"]}');
  } finally { await rm(home, { recursive: true, force: true }); }
});
