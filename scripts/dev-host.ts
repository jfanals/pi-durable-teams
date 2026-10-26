// A throwaway host with a faux model for building and screenshotting phone clients.
// Usage: node scripts/dev-host.ts [port]   → prints the pairing URL; Ctrl+C removes everything.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startHost } from "../src/host.ts";
import { remoteToken } from "../src/remote.ts";
import { SocketHostSource } from "../src/source.ts";
import { Client } from "../src/client.ts";

const port = Number(process.argv[2] ?? 8790);
const directory = await mkdtemp(join(tmpdir(), "pi-agents-dev-"));
await writeFile(join(directory, "config.json"), JSON.stringify({ remote: { port } }));
const fake = fauxProvider({ tokensPerSecond: 40, models: [{ id: "faux-1", reasoning: true }, { id: "faux-opus", name: "Faux Opus", reasoning: true }] });
// Message keywords pick a behaviour: DELEGATE spawns a sub-agent, SLOW streams for a while, anything else answers in markdown.
fake.setResponses(Array.from({ length: 500 }, () => request => {
  const last = request.messages.findLast(message => message.role !== "system");
  const text = JSON.stringify(last);
  if (last?.role === "user" && text.includes("DELEGATE")) return fauxAssistantMessage([fauxThinking("I should ask a helper to read the code."), fauxToolCall("team", { action: "spawn", name: "reader", message: "Read src/ and report the entry points" })], { stopReason: "toolUse" });
  if (last?.role === "user" && text.includes("SLOW")) return fauxAssistantMessage("Working through it slowly. ".repeat(400));
  if (last?.role === "user" && text.includes("READ")) return fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" });
  return fauxAssistantMessage("Here is what I found:\n\n- **Entry point:** `src/host.ts`\n- Routes live under `/agents`\n\n```ts\nconst host = await startHost(dir, socket, options);\n```\n\nAnything else?");
}));
const models = createModels(); models.setProvider(fake.provider);
const host = await startHost(directory, join(directory, "s"), { models, agentModel: async () => ({ provider: "faux", modelId: "faux-1" }) });
const token = await remoteToken(directory);
const source = new SocketHostSource(new Client(join(directory, "s")));
const lead = await source.newAgent({ name: "lead", cwd: process.cwd() });
await source.newAgent({ name: "docs-writer", cwd: directory });
await source.send(lead.id!, "DELEGATE please look at the code");
console.log(`Dev host ${process.pid} · state ${directory}`);
console.log(`http://127.0.0.1:${port}/?token=${token}`);
const stop = async () => { await host.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
