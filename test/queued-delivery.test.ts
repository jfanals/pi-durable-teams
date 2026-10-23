import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { startHost } from "../src/host.ts";
import { Client } from "../src/client.ts";
import extension from "../src/extension.ts";
import { IDENTITY_TYPE, MESSAGE_TYPE } from "../src/protocol.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

test("a report queued in busy Pi is not acknowledged early or duplicated by a host reconnect", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-queue-")); const socket = join(directory, "s");
  const fake = fauxProvider(); fake.setResponses([fauxAssistantMessage("worker report")]);
  const models = createModels(); models.setProvider(fake.provider);
  let host = await startHost(directory, socket, { models });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let queued!: () => void; const incoming = new Promise<void>(resolve => { queued = resolve; });
  let replayed!: () => void; const reconnected = new Promise<void>(resolve => { replayed = resolve; });
  let deliveries = 0;
  const main = fauxProvider();
  main.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Main's original answer."), fauxAssistantMessage("Report received."),
  ]);
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(main.provider);
  const settings = SettingsManager.inMemory({}); settings.setProjectTrusted(true);
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  class OfflineClient extends Client {
    override async ensureHost(signal?: AbortSignal) { await this.call("health", {}, signal); }
    override async stream(operation: "events" | "watch", body: unknown, signal: AbortSignal, receive: (value: any) => void | Promise<void>) {
      return super.stream(operation, body, signal, async value => {
        await receive(value);
        if (value.delivery) { queued(); if (++deliveries === 2) replayed(); }
      });
    }
  }
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      extension(pi, () => new OfflineClient(socket));
      pi.registerTool({ name: "hold", label: "Hold", description: "Offline test gate", parameters: Type.Object({}),
        execute: async () => { entered(); await gate; return { content: [{ type: "text", text: "released" }], details: {} }; },
      });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager: settings,
    resourceLoader: loader, modelRuntime: runtime, model: runtime.getModel("faux", "faux-1")!, sessionManager: manager,
  });
  try {
    await session.bindExtensions({ mode: "json" });
    const running = session.prompt("Hold while a worker finishes."); await started;
    const entry = manager.getEntries().find(e => e.type === "custom" && e.customType === IDENTITY_TYPE)!;
    assert.equal(entry.type, "custom");
    const identity = (entry as any).data;
    // The tool handler blocks, so we dispatch through the same host operation instead.
    const client = new Client(socket);
    await client.call("register", { ...identity, name: "Busy Pi", cwd: directory, model: { provider: "faux", modelId: "faux-1" } });
    const actor = await host.service.authenticate(identity.sessionId, identity.secret);
    const request = await host.service.action(actor, { action: "spawn", name: "reader", message: "finish" }, "worker") as any;
    await host.service.harness.waitForTask(request.taskId, BACKGROUND_CONTEXT);
    await incoming;
    assert.equal(manager.getEntries().filter(e => e.type === "custom_message" && e.customType === MESSAGE_TYPE).length, 0);
    assert.equal((await host.service.pending(actor)).length, 1);
    await host.close(); host = await startHost(directory, socket, { models });
    await reconnected;
    let received!: () => void; const persisted = new Promise<void>(resolve => { received = resolve; });
    session.subscribe(event => { if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === MESSAGE_TYPE) received(); });
    release(); await running; await persisted; await session.waitForIdle();
    await host.service.harness.commit(() => {}, BACKGROUND_CONTEXT);
    assert.equal(manager.getEntries().filter(e => e.type === "custom_message" && e.customType === MESSAGE_TYPE).length, 1);
    assert.equal((await host.service.pending(actor)).length, 0);
  } finally {
    release();
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose(); await host.close(); await rm(directory, { recursive: true, force: true });
  }
});
