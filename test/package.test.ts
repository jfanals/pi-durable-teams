import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { openTeams } from "../src/teams.ts";

test("actual Pi package discovery/Jiti loads one team tool and the canonical skill without starting a session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-package-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory,
      settingsManager: SettingsManager.inMemory({ packages: [root] }), noThemes: true, noPromptTemplates: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.filter(e => e.tools.has("team")).length, 1);
    assert.equal(loader.getSkills().skills.filter(s => s.name === "durable-teams").length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("standard Durable read/write tools really operate in the assigned worker directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-tool-cwd-"));
  await writeFile(join(directory, "input.txt"), "fixture in assigned directory");
  const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write", { path: "output.txt", content: "worker result" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Read and wrote the fixture."),
  ]);
  const registry = createRegistry(); registry.install(CodingTools);
  const service = await openTeams(new MemoryStorage(), { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }) });
  try {
    const actor = await service.register({ sessionId: "cwd-main", secret: "x".repeat(36), cwd: directory, name: "Main", model: { provider: "faux", modelId: "faux-1" } });
    const request = await service.action(actor, { action: "spawn", name: "files", message: "Read/write fixtures" }, "files") as any;
    const settled = await service.harness.waitForTask(request.taskId, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, "completed");
    assert.equal(await readFile(join(directory, "output.txt"), "utf8"), "worker result");
    const transcript = await service.action(actor, { action: "inspect", target: "files", transcript: true }, "log");
    assert.match(JSON.stringify(transcript), /fixture in assigned directory/);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
