import {
  archiveView,
  statusWord,
  statusTone,
  mark,
  olderFrom,
  OLDER_LABEL,
  teamGlance,
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
/** Decisions waiting on the human: an amber count before the agent's name. */
export const askCount = (a: Agent) => a.asks?.length ? `<span class="ask-count" title="${a.asks.length} waiting on you">${a.asks.length}</span> ` : "";
/** The open agent's asks above the composer: each jumps to where it was asked and adds its reply line. */
export const asksBar = (a?: Agent) => (a?.asks ?? []).map(ask =>
  `<button type="button" class="ask" data-ask="${escape(ask.entry)}" data-title="${escape(ask.title)}" title="${escape(ask.text)}">${escape(ask.title)}${ask.text ? `: ${escape(ask.text)}` : ""}${ask.at ? ` <small>${escape(formatAgo(Date.now() - ask.at))}</small>` : ""}</button>`
  + (ask.options?.length ? `<div class="ask-options">${ask.options.map(option =>
    `<button type="button" data-ask="${escape(ask.entry)}" data-title="${escape(ask.title)}" data-option="${escape(option)}" title="${escape(option)}">${escape(option)}</button>`).join("")}</div>` : "")).join("");
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
      if (item.kind === "compaction")
        return `<details class="compaction" data-card="compaction:${escape(item.id)}">
<summary>[compaction] ${item.tokensBefore ? `Compacted from ${item.tokensBefore.toLocaleString()} tokens` : "Context compacted"}</summary>
<div class="markdown">${markdown(item.summary)}</div>
</details>`;
      if (item.kind === "notice") return `<p class="notice${item.warning ? " warning" : ""}">${escape(item.text)}</p>`;
      if (item.kind === "input")
        return `<article class="input">
<small>${escape(item.from)}${item.report ? " · report" : ""}</small>
${!item.report && item.from === "Human" ? `<button data-rewind="${escape(item.id)}">Rewind here</button>` : ""}
<div class="markdown">${markdown(item.text, true)}</div>
${item.images?.length ? `<span data-images="${escape(item.id)}">[image]</span>` : ""}
</article>`;
      const parts = item.parts
        .map((part) => {
          if (part.type === "text") return `<div class="markdown">${markdown(part.text)}</div>`;
          if (part.type === "thinking")
            return `<div class="thinking markdown">${markdown(part.text)}</div>`;
          const result = results.get(part.id);
          const icon = result ? (result.ok ? "✓" : "✗") : "○";
          const args = part.args ?? {};
          const prompt = args.message ?? args.command ?? JSON.stringify(args);
          const output = result?.content?.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
          return `<details class="tool ${result?.ok === false ? "error" : ""}" data-card="tool:${escape(part.id)}">
<summary>${icon} <strong>${escape(part.name)}</strong> ${escape(part.subject)}</summary>
<div class="tool-body"><pre>${escape(prompt)}</pre>${output ? `<pre>${escape(output)}</pre>` : ""}
${result?.error ? `<p class="error">${escape(result.error)}</p>` : ""}
${result?.content?.some(part => part.type === "image") ? `<span data-images="${escape(result.id)}">[image]</span>` : ""}</div></details>`;
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
      return `<article class="reply" data-entry="${escape(item.id)}"><button data-rewind="${escape(item.id)}">Rewind here</button>${parts}${error}
${turn ? `<small class="stamp">${stamp}</small>` : ""}</article>`;
    })
    .join("");
}

/** Between the agents active in the last day and the rest, on the dashboard and its rail. */
export const olderDivider = `<div class="divider" role="separator">${OLDER_LABEL}</div>`;
/** Compact roster views only; status and team folding stay shared with the dashboard. */
/** The side columns. Idle sub-agents fold into a summary line everywhere; only the open agent's column lists them, on a click (`showIdle`). */
export function paneRails(agents: Agent[], stack: string[], showIdle = false) {
  const main = agents.find(a => a.id === stack[0]);
  const row = (a: Agent, child = false) => `<button tabindex="-1" class="rail-row ${child ? "child" : ""} ${stack.includes(a.id) ? "open" : ""}" data-open="${escape(a.id)}" title="${escape(a.name)} · ${escape(statusWord(a))}" ${stack.includes(a.id) ? 'aria-current="true"' : ""}>
<span aria-hidden="true" class="tone-${statusTone(a)}">${mark(a)}</span><span class="${a.running || a.unread ? "busy" : ""}">${askCount(a)}${escape(a.name)}</span></button>`;
  const active = archiveView(agents, false).agents;
  const older = olderFrom(active);
  const dashboard = active.map((a, index) => {
    const glance = teamGlance(a.children);
    return (index === older ? olderDivider : "") + row(a) + (glance.shown as Agent[]).map(c => row(c, true)).join("")
      + (glance.summary ? `<small class="rail-summary">${escape(glance.summary)}</small>` : "");
  }).join("");
  const team = main?.children.filter(c => main.archived || !c.archived) ?? [];
  const glance = teamGlance(team);
  const mainTeam = showIdle ? team.map(c => row(c, true)).join("")
    : (glance.shown as Agent[]).map(c => row(c, true)).join("") + (glance.summary ? `<button tabindex="-1" class="rail-summary" data-action="idle">${escape(glance.summary)}</button>` : "");
  return { dashboard: `<button tabindex="-1" class="rail-header" data-depth="0">Pi Agents</button>${dashboard}`,
    main: main ? `<button tabindex="-1" class="rail-header" data-depth="1">${escape(main.name)}</button><small class="rail-activity">${escape(statusWord(main))}</small>${mainTeam}` : "" };
}
export function panePath(agents: Agent[], stack: string[]) {
  const all = agents.flatMap(a => [a, ...a.children]);
  return `<span class="ancestor dashboard"><a href="/" data-depth="0">Pi Agents</a><span aria-hidden="true"> › </span></span>`
    + stack.slice(0, -1).map((id, i) => `<span class="ancestor main"><a href="/#agent=${encodeURIComponent(id)}" data-depth="${i + 1}">${escape(all.find(a => a.id === id)?.name ?? id)}</a><span aria-hidden="true"> › </span></span>`).join("")
    + `<span id="title">${escape(all.find(a => a.id === stack.at(-1))?.name ?? "Agent")}</span>`; // its asks are listed right below
}
