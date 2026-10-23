import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workerInstructions } from "../src/resources.ts";

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
