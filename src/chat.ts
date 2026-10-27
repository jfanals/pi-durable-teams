import { clean, firstLine, textOf, replyTokens } from "./status.ts";

export type TranscriptEntry = { id: number | string; kind: string; model?: readonly any[]; data?: any };
export type ToolCall = { id: string; name: string; subject: string; args?: Record<string, unknown> };
export type ToolOutput = { type: "text"; text: string } | { type: "image"; mimeType?: string };
export type ChatItem =
  | { id: string; kind: "input"; from: string; text: string; report?: boolean; at?: number }
  | { id: string; kind: "reply"; parts: ({ type: "text"; text: string } | { type: "thinking"; text: string } | ({ type: "tool" } & ToolCall))[]; error?: string; at?: number; turn?: { ms?: number; tokens: number; cost: number } }
  | { id: string; kind: "result"; callId: string; ok: boolean; error?: string; content?: ToolOutput[]; details?: unknown; durationMs?: number }
  | { id: string; kind: "notice"; text: string; warning?: boolean };
/** Messages waiting for the agent's next boundary, oldest first, as Pi shows them above its editor. */
export type Queued = { mode: "steer" | "followUp"; text: string };
/** Committed entries only. Prefix entries complete the oldest request without appearing in the returned page. */
const MAX_TEXT = 8_000;
/** Keeps both ends of long text: Pi's renderers preview a file's head and a command's tail. */
const bound = (text: string) => text.length <= MAX_TEXT ? text
  : `${text.slice(0, MAX_TEXT / 2)}\n… ${text.length - MAX_TEXT} characters omitted …\n${text.slice(-MAX_TEXT / 2)}`;
const boundArgs = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).map(([key, value]) =>
  [key, typeof value === "string" ? bound(value) : (JSON.stringify(value)?.length ?? 0) > MAX_TEXT ? "[too large]" : value]));
export function chatItems(entries: readonly TranscriptEntry[], prefix: readonly TranscriptEntry[] = []): ChatItem[] {
  const items: ChatItem[] = [];
  let start: number | undefined; let tokens = 0; let cost = 0;
  for (const entry of [...prefix, ...entries].sort((a, b) => Number(a.id) - Number(b.id))) {
    const id = String(entry.id); const message = entry.model?.[0];
    const at = typeof message?.timestamp === "number" ? message.timestamp : undefined;
    switch (entry.kind) {
      case "teams.message": case "teams.report": case "pi.user":
        if (at !== undefined && start === undefined) { start = at; tokens = 0; cost = 0; }
        items.push({ id, kind: "input", from: clean(entry.data?.from?.name ?? "input"),
          text: clean(entry.kind === "pi.user" ? textOf(message)
            : entry.data?.message ?? textOf(message).replace(/^\[[^\]\n]*\]: /, "")),
          ...(entry.kind === "teams.report" ? { report: true } : {}), at });
        break;
      case "pi.assistant": {
        const parts = Array.isArray(message?.content) ? message.content : [];
        const item: ChatItem & { kind: "reply" } = { id, kind: "reply", at,
          parts: (typeof message?.content === "string" ? [{ type: "text", text: message.content }] : parts).flatMap((p: any) => {
            if (p.type === "text") return [{ type: "text", text: clean(p.text) }];
            if (p.type === "thinking") return [{ type: "thinking", text: clean(p.thinking) }];
            if (p.type !== "toolCall") return [];
            const args = p.arguments ?? {};
            return [{ type: "tool", id: p.id, name: clean(p.name), subject: firstLine(args.path ?? args.command ?? args.target ?? Object.values(args).find(v => typeof v === "string") ?? ""), args: boundArgs(args) }];
          }) };
        if (["error", "aborted"].includes(message?.stopReason)) item.error = clean(`${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ""}`);
        const u = message?.usage;
        tokens += replyTokens(u); cost += u?.cost?.total ?? 0;
        if (message?.stopReason && message.stopReason !== "toolUse" && at !== undefined) {
          item.turn = { ...(start !== undefined && at >= start ? { ms: at - start } : {}), tokens, cost };
          start = undefined; tokens = 0; cost = 0;
        }
        items.push(item); break;
      }
      case "pi.tool-result":
        if (message?.toolCallId) {
          // Pi's tool renderers draw from this output; image bytes stay on the host.
          const content: ToolOutput[] = (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [])
            .map((part: any) => part.type === "image" ? { type: "image", mimeType: part.mimeType } : { type: "text", text: bound(clean(part.text ?? "")).replace(/<\/?harness>/g, "") });
          const details = (JSON.stringify(message.details)?.length ?? 0) <= MAX_TEXT ? message.details : undefined;
          items.push({ id, kind: "result", callId: message.toolCallId, ok: !message.isError, content,
            ...(message.isError ? { error: firstLine(textOf(message).replace(/<\/?harness>/g, "").replace(/^\[error\]\s*/m, "")) } : {}),
            ...(details === undefined ? {} : { details }), ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}) });
        }
        break;
      case "teams.placeholder": items.push({ id, kind: "notice", text: clean(entry.data?.text) }); break;
      case "pi.system": break;
      // Shown as Pi's "Cache warmed" line only where Pi shows it (showCacheMissNotices); teams.ts adds it.
      case "teams.cache-warm": break;
      case "pi.compaction": items.push({ id, kind: "notice", text: "— context compacted —" }); break;
      case "pi.reset": items.push({ id, kind: "notice", text: "— context reset —" }); break;
      default: items.push({ id, kind: "notice", text: `[${clean(entry.kind)}]` });
    }
  }
  const visible = new Set(entries.map(entry => String(entry.id)));
  return items.filter(item => visible.has(item.id));
}
