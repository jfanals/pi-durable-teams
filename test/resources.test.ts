import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { workerInstructions } from "../src/resources.ts";
import { contextLimit, withContextLimits, writeContextLimit } from "../src/limits.ts";

test("public resource loaders find project/global skills, omit legacy skills, and refresh on each spawn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-resources-"));
  const project = join(directory, "project"); const agent = join(directory, "agent");
  try {
    await mkdir(join(project, ".pi", "skills", "project-checks"), { recursive: true });
    for (const name of ["global-checks", "pi-fleet"]) {
      await mkdir(join(agent, "skills", name), { recursive: true });
      await writeFile(join(agent, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Run ${name}.\n---\nInstructions.`);
    }
    await writeFile(join(project, ".pi", "skills", "project-checks", "SKILL.md"), "---\nname: project-checks\ndescription: Run project checks.\n---\nInstructions.");
    await writeFile(join(project, "AGENTS.md"), "Never publish fixture code.");
    await mkdir(join(directory, "shared-skills", "shared-checks"), { recursive: true });
    await writeFile(join(directory, "shared-skills", "shared-checks", "SKILL.md"), "---\nname: shared-checks\ndescription: Run shared checks.\n---\nInstructions.");
    await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ skills: ["skills", "../../shared-skills"] }));
    await mkdir(join(project, ".pi", "extensions"), { recursive: true });
    const marker = join(directory, "extension-was-executed");
    await writeFile(join(project, ".pi", "extensions", "side-effect.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export default function () {}`);
    const instructions = await workerInstructions(project, agent);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.match(instructions, /Never publish fixture code/);
    assert.match(instructions, /global-checks/);
    assert.match(instructions, /project-checks/);
    assert.match(instructions, /shared-checks/);
    assert.match(instructions, /durable-teams/);
    assert.doesNotMatch(instructions, /<name>pi-fleet<\/name>/);
    await writeFile(join(project, "AGENTS.md"), "Updated fixture instructions.");
    assert.match(await workerInstructions(project, agent), /Updated fixture instructions/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("context limits round-trip through Pi's per-model compaction setting and move the worker's compaction point", async () => {
  const agent = await mkdtemp(join(tmpdir(), "teams-limits-"));
  try {
    const opus = { provider: "claude-code", id: "opus", contextWindow: 1_000_000 };
    const other = { provider: "x", id: "small", contextWindow: 100_000 };
    await writeFile(join(agent, "settings.json"), JSON.stringify({ theme: "dark", compaction: { modelOverrides: { "claude-code/opus": { keepRecentTokens: 5000 } } } }));
    const settings = SettingsManager.create(agent, agent);
    const models = { getModel: (provider: string, id: string) => [opus, other].find(m => m.provider === provider && m.id === id) } as any;
    const limited = withContextLimits(models, settings);
    assert.equal(contextLimit(settings, opus), 98); // Pi's default reserve, 16384
    assert.equal(limited.getModel("claude-code", "opus")!.contextWindow, 1_000_000);

    await writeContextLimit(opus, 60, agent); await settings.reload();
    const saved = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
    assert.equal(saved.theme, "dark");
    assert.deepEqual(saved.compaction.modelOverrides["claude-code/opus"], { keepRecentTokens: 5000, reserveTokens: 400_000 });
    assert.equal(contextLimit(settings, opus), 60);
    // pi-durable compacts at window - global reserve: the shrunk window puts that at 60% of the real one.
    const seen = limited.getModel("claude-code", "opus")!;
    assert.equal(seen.contextWindow - settings.getCompactionReserveTokens(), 600_000);
    assert.equal(limited.getModel("x", "small"), other);

    await writeContextLimit(opus, undefined, agent); await settings.reload();
    assert.deepEqual(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")).compaction.modelOverrides["claude-code/opus"], { keepRecentTokens: 5000 });
    assert.equal(limited.getModel("claude-code", "opus")!.contextWindow, 1_000_000);
  } finally { await rm(agent, { recursive: true, force: true }); }
});
