import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { openTeams } from "../src/teams.ts";
import { openWebTools } from "../src/web.ts";

const ctx = BACKGROUND_CONTEXT;
test("MCP tools in a durable model turn: schema, results, tool errors and restart after exit", { timeout: 10000 }, async () => {
  let server!: InMemoryTransport;
  let starts = 0;
  let calls = 0;
  const web = await openWebTools(() => {
    starts++;
    const pair = createInMemoryTransportPair();
    server = pair.server;
    server.onMessage(async message => {
      if (!("method" in message) || !("id" in message)) return;
      let result: unknown;
      if (message.method === "initialize") result = {
        protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-web", version: "1" },
      };
      else if (message.method === "tools/list") result = { tools: [{
        name: "web_search", description: "Search the web", inputSchema: {
          type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
        },
      }] };
      else if (message.method === "tools/call") {
        calls++;
        const args = (message.params as { arguments: { query: string } }).arguments;
        if (args.query === "exit") { await server.close(); return; }
        result = args.query === "error" ? { content: [{ type: "text", text: "provider unavailable" }], isError: true }
          : { content: [], structuredContent: { sources: [{ title: "Pi", url: "https://pi.dev" }] } };
      } else throw new Error(`Unexpected MCP method ${message.method}`);
      await server.send({ jsonrpc: "2.0", id: message.id, result });
    });
    void server.start();
    return pair.client;
  });
  const registry = createRegistry(); registry.install(web.extension);
  assert.equal(web.extension.tools?.[0]?.replay, "safe");
  const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
  let query = "Pi";
  const results: any[] = [];
  fake.setResponses(Array.from({ length: 30 }, () => request => {
    const last = request.messages.findLast(m => m.role !== "system");
    if (last?.role === "toolResult") {
      results.push(last);
      return fauxAssistantMessage("done");
    }
    const tool = request.messages.flatMap(m => m.role === "system" ? m.toolsAdded ?? [] : []).find(t => t.name === "web_search");
    assert.deepEqual(tool?.parameters, web.extension.tools?.[0]?.parameters);
    return fauxAssistantMessage(fauxToolCall("web_search", { query }), { stopReason: "toolUse" });
  }));
  const service = await openTeams(new MemoryStorage(), { models, registry });
  try {
    const main = await service.register({ sessionId: "web-main", secret: "x".repeat(36), name: "Main", cwd: tmpdir(), model: { provider: "faux", modelId: "faux-1" } });
    for (const [index, input] of ["Pi", "error", "exit", "Pi"].entries()) {
      query = input;
      const result = await service.action(main, index === 0
        ? { action: "spawn", name: "searcher", message: "Search" }
        : { action: "send", target: "searcher", message: "Search again" }, `web-${index}`) as { taskId: TaskId };
      const task = await service.harness.waitForTask(result.taskId, ctx);
      assert.equal(task.state.outcome.status, "completed");
    }
    assert.equal(starts, 2);
    assert.equal(calls, 4);
    assert.match(JSON.stringify(results[0]), /https:\/\/pi.dev/);
    assert.equal(results[1].isError, true);
    assert.match(JSON.stringify(results[1]), /provider unavailable/);
    assert.equal(results[2].isError, true);
    assert.equal(results[3].isError, false);
  } finally { await service.close(); await web.close(); }
});
