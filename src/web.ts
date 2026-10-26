import { fileURLToPath } from "node:url";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, toLlmContent, type McpTransport } from "@earendil-works/pi-mcp";
import type { TSchema } from "typebox";

/** One server shared by every conversation in this host. Transport injection is for offline tests. */
export async function openWebTools(transport: () => McpTransport = () => new StdioTransport({
  command: process.execPath,
  args: [fileURLToPath(import.meta.resolve("pi-web-access/dist/mcp-cli.js"))],
  stderr: "inherit",
})) {
  let client: McpClient | undefined;
  let connecting: Promise<McpClient> | undefined;
  async function connected(): Promise<McpClient> {
    if (client?.connectionState === "connected") return client;
    if (!connecting) connecting = (async () => {
      const next = new McpClient({ name: "pi-durable-teams", version: "0.1.0" });
      try {
        await next.connect(transport());
        client = next;
        return next;
      } catch (error) {
        await next.close();
        throw error;
      }
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  const initial = await connected();
  try {
    const tools = await initial.listTools();
    const extension = defineExtension({
      name: "teams-web",
      tools: tools.map(tool => defineTool({
        name: tool.name,
        description: tool.description ?? tool.name,
        // MCP already supplies JSON Schema; do not maintain a second local schema.
        parameters: tool.inputSchema as TSchema,
        replay: "safe",
        async execute(args, _api, context) {
          const active = await connected();
          // Searches with page content and multi-URL fetches outlast pi-mcp's 30 s default; the run's abort ends them.
          const result = await active.callTool(tool.name, args as Record<string, unknown>, { signal: context.abortSignal, timeoutMs: Infinity });
          return { output: toLlmContent(result), isError: result.isError };
        },
      })),
    });
    return { extension, async close() { await connecting?.catch(() => {}); await client?.close(); } };
  } catch (error) {
    await initial.close();
    throw error;
  }
}
