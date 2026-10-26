import { clean, firstLine, textOf, replyTokens } from "./status.ts";

export type TranscriptEntry = { id: number | string; kind: string; model?: any[]; data?: any };
export type ToolCall = { id: string; name: string; subject: string };
export type ChatItem =
  | { id: string; kind: "input"; from: string; text: string; report?: boolean; at?: number }
  | { id: string; kind: "reply"; parts: ({ type: "text"; text: string } | { type: "thinking"; text: string } | ({ type: "tool" } & ToolCall))[]; error?: string; at?: number; turn?: { ms?: number; tokens: number; cost: number } }
  | { id: string; kind: "result"; callId: string; ok: boolean; error?: string }
  | { id: string; kind: "notice"; text: string };
/** Committed entries only. Prefix entries complete the oldest request without appearing in the returned page. */
export function chatItems(entries: TranscriptEntry[], prefix: TranscriptEntry[] = []): ChatItem[] {
  const items: ChatItem[] = [];
  let start: number | undefined; let tokens = 0; let cost = 0;
  for (const entry of [...prefix, ...entries].sort((a, b) => Number(a.id) - Number(b.id))) {
    const id = String(entry.id); const message = entry.model?.[0];
    const at = typeof message?.timestamp === "number" ? message.timestamp : undefined;
    switch (entry.kind) {
      case "teams.message": case "teams.report": case "pi.user":
        if (at !== undefined && start === undefined) { start = at; tokens = 0; cost = 0; }
        items.push({ id, kind: "input", from: clean(entry.data?.from?.name ?? "input"),
          text: clean(entry.kind === "teams.message" ? entry.data?.message ?? textOf(message) : textOf(message)),
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
            return [{ type: "tool", id: p.id, name: clean(p.name), subject: firstLine(args.path ?? args.command ?? args.target ?? Object.values(args).find(v => typeof v === "string") ?? "") }];
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
        if (message?.toolCallId) items.push({ id, kind: "result", callId: message.toolCallId, ok: !message.isError,
          ...(message.isError ? { error: firstLine(textOf(message).replace(/<\/?harness>/g, "").replace(/^\[error\]\s*/m, "")) } : {}) });
        break;
      case "teams.placeholder": items.push({ id, kind: "notice", text: clean(entry.data?.text) }); break;
      case "pi.system": break;
      case "pi.compaction": items.push({ id, kind: "notice", text: "— context compacted —" }); break;
      case "pi.reset": items.push({ id, kind: "notice", text: "— context reset —" }); break;
      default: items.push({ id, kind: "notice", text: `[${clean(entry.kind)}]` });
    }
  }
  const visible = new Set(entries.map(entry => String(entry.id)));
  return items.filter(item => visible.has(item.id));
}
