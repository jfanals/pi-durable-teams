import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { startHost } from "../src/host.ts";
import { Client } from "../src/client.ts";
import extension from "../src/extension.ts";
import { IDENTITY_TYPE, MESSAGE_TYPE } from "../src/protocol.ts";

class OfflineClient extends Client {
  override async ensureHost(signal?: AbortSignal) {
    if (!(await this.call("health", {}, signal)).ready) throw new Error("Offline fixture host not ready");
  }
}

// Real coding-agent SDK, extension lifecycle, model tool calls and session persistence;
// both model providers are deterministic/offline. No global settings or credentials.
test("ordinary Pi delegates, persists and acknowledges a report, then reconnects without replay", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "teams-pi-")); const socket = join(directory, "s");
  const workers = fauxProvider(); workers.setResponses([fauxAssistantMessage("worker completed the assignment")]);
  const models = createModels(); models.setProvider(workers.provider);
  const host = await startHost(directory, socket, { models });
  const mainFake = fauxProvider();
  mainFake.setResponses([
    fauxAssistantMessage(fauxToolCall("team", { action: "spawn", name: "reader", message: "inspect this project" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Worker launched."),
    fauxAssistantMessage("I received the worker report."),
  ]);
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(mainFake.provider);
  const settings = SettingsManager.inMemory({}); settings.setProjectTrusted(true);
  let manager = SessionManager.create(directory, join(directory, "sessions"));
  let instance: Awaited<ReturnType<typeof createAgentSession>> | undefined;
  let allowAck = false;
  let acknowledged!: () => void; const ack = new Promise<void>(resolve => { acknowledged = resolve; });
  class ReceiptClient extends OfflineClient {
    override async call<T = any>(operation: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
      if (operation === "ack" && !allowAck) throw new Error("Simulated crash window: message persisted, receipt not delivered");
      const result = await super.call<T>(operation, body, signal);
      if (operation === "ack") acknowledged();
      return result;
    }
  }
  async function open() {
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [pi => extension(pi, () => new ReceiptClient(socket))],
    });
    await loader.reload();
    const result = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager: settings,
      resourceLoader: loader, modelRuntime: runtime, model: runtime.getModel("faux", "faux-1")!, sessionManager: manager,
    });
    await result.session.bindExtensions({ mode: "json", onError: error => { throw new Error(JSON.stringify(error)); } });
    return result;
  }
  async function close() {
    if (!instance) return;
    await instance.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    instance.session.dispose(); instance = undefined;
  }
  try {
    instance = await open();
    let delivered!: () => void;
    const receipt = new Promise<void>(resolve => { delivered = resolve; });
    instance.session.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === MESSAGE_TYPE) delivered();
    });
    await instance.session.prompt("Delegate this task to reader.");
    await receipt;
    await instance.session.waitForIdle();
    const entries = manager.getEntries();
    assert.equal(entries.filter(e => e.type === "custom_message" && e.customType === MESSAGE_TYPE).length, 1);
    const identity = entries.find(e => e.type === "custom" && e.customType === IDENTITY_TYPE);
    assert.ok(identity?.type === "custom");
    const credentials = identity.data as { sessionId: string; secret: string };
    // message_end handlers finish asynchronously relative to SDK listeners; a session-bound
    // host commit barrier lets the receipt acknowledgement finish before checking it.
    await host.service.harness.commit(() => {}, BACKGROUND_CONTEXT);
    const actor = await host.service.authenticate(credentials.sessionId, credentials.secret);
    assert.equal((await host.service.pending(actor)).length, 1);
    const sessionFile = manager.getSessionFile()!;
    await close(); allowAck = true; manager = SessionManager.open(sessionFile); instance = await open();
    await ack;
    assert.equal(manager.getEntries().filter(e => e.type === "custom_message" && e.customType === MESSAGE_TYPE).length, 1);
    assert.equal((await host.service.pending(actor)).length, 0);
  } finally { await close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});
