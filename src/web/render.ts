import {
  formatUsage,
  formatAgo,
  formatContext,
  formatCost,
  formatDuration,
  formatTokens,
} from "../status.ts";
import type { ChatItem } from "../chat.ts";
import type { Agent } from "./api.ts";
import { marked } from "marked";
export const escape = (text: unknown): string =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const safeLink = (href: string) => /^https?:/i.test(href);
marked.use({
  renderer: {
    html({ text }: { text: string }) {
      return escape(text);
    },
    link(
      this: { parser: { parseInline(tokens: unknown): string } },
      { href, tokens }: { href: string; tokens: unknown },
    ): string {
      const label = this.parser.parseInline(tokens);
      return safeLink(href)
        ? `<a href="${escape(href)}" rel="noopener noreferrer" target="_blank">${label}</a>`
        : label;
    },
    image({ text }: { text: string }) {
      return escape(text);
    },
  },
});
export const markdown = (text: string, breaks = false): string =>
  marked.parse(text, { async: false, breaks });
export const info = (a: Agent) =>
  [
    a.model,
    a.thinking,
    a.running && a.since
      ? formatDuration(Date.now() - a.since)
      : a.finishedAt
        ? formatAgo(Date.now() - a.finishedAt)
        : "",
    formatContext(a),
    formatCost(a.cost),
    a.subscription ? "(sub)" : "",
  ]
    .filter(Boolean)
    .join(" · ");
export function footerInfo(a: Agent) {
  return `${[a.model, a.thinking].filter(Boolean).join(" · ")}\n${formatUsage(a)}${a.cwd ? `\n${a.cwd}` : ""}`;
}
export function transcript(items: ChatItem[]) {
  const results = new Map(items.flatMap((i) => (i.kind === "result" ? [[i.callId, i] as const] : [])));
  return items
    .map((item) => {
      if (item.kind === "result") return "";
      if (item.kind === "notice") return `<p class="notice${item.warning ? " warning" : ""}">${escape(item.text)}</p>`;
      if (item.kind === "input")
        return `<article class="input">
<small>${escape(item.from)}${item.report ? " · report" : ""}</small>
<div class="markdown">${markdown(item.text, true)}</div>
</article>`;
      const parts = item.parts
        .map((part, index) => {
          if (part.type === "text") return `<div class="markdown">${markdown(part.text)}</div>`;
          if (part.type === "thinking")
            return `<details data-thinking="${escape(`${item.id}-${index}`)}">
<summary>Thinking</summary>
<div class="thinking">${escape(part.text)}</div>
</details>`;
          const result = results.get(part.id);
          const icon = result ? (result.ok ? "✓" : "✗") : "○";
          const error = result?.error ? `<br>${escape(result.error)}` : "";
          return `<div class="tool ${result?.ok === false ? "error" : ""}">${icon}
<strong>${escape(part.name)}</strong> ${escape(part.subject)}${error}</div>`;
        })
        .join("");
      const turn = item.turn;
      const stamp = turn
        ? [
            turn.ms === undefined ? "" : formatDuration(turn.ms),
            `${formatTokens(turn.tokens)} tokens`,
            formatCost(turn.cost),
          ]
            .filter(Boolean)
            .join(" · ")
        : "";
      const error = item.error ? `<p class="error">${escape(item.error)}</p>` : "";
      return `<article class="reply">${parts}${error}
${turn ? `<small class="stamp">${stamp}</small>` : ""}</article>`;
    })
    .join("");
}
