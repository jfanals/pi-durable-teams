// Terminal presentation only. Nothing here changes delivery, acknowledgement or worker execution.
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { promptAutocomplete } from "./autocomplete.ts";
import { NEW } from "./agent-name.ts";
import { agentDir } from "./paths.ts";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { piClipboard } from "./presentation.ts";
import { homedir } from "node:os";

import { CompactionSummaryMessageComponent, getMarkdownTheme, getSelectListTheme, keyText, ToolExecutionComponent, UserMessageSelectorComponent, type Theme, type ThemeBg } from "@earendil-works/pi-coding-agent";
import { builtInRenderers, loadToolRenderers, piExternalEditor, piModelSelector, piThinkingSelector, piTreeSelector } from "./presentation.ts";
import {
  Box, Editor, getKeybindings, Loader, ScrollView, VStack, Key, Markdown, matchesKey, MouseRegion, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type DefaultTextStyle, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { clean, firstLine, textOf, formatUsage, statusWord, formatDuration, formatAgo, formatTokens, formatContext, formatCost, teamGlance, type WorkerStatus } from "./status.ts";
import type { TreeResult } from "./source.ts";
import { askReply, type Ask, type ChatItem, type Queued } from "./chat.ts";
import type { ModelChoice } from "./model-choices.ts";
import type { ImageContent, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { nextModel, modelThinking, modelNotice, thinkingSelection } from "./model-selection.ts";
import type { Action, Delivery, Mode } from "./protocol.ts";

export type ViewResult = { type: "back" } | { type: "send"; mode: Mode } | { type: "abort" };

const COLLAPSED_LINES = 4;
// Same small formatter as Pi's footer (not exported by its public package index).
const formatCwd = (cwd: string) => {
  const home = homedir();
  return cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
};
const expandKey = () => { try { return keyText("app.tools.expand") || "ctrl+o"; } catch { return "ctrl+o"; } };


export const glyph = (w: WorkerStatus) => w.running ? "●" : "○";
/** Decisions waiting on the human: an amber count before the agent's name ("" when none). */
export const askCount = (w: WorkerStatus | undefined, theme: Theme) => w?.asks?.length ? `${theme.fg("warning", String(w.asks.length))} ` : "";
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const VISIBLE_RUNNING = 5;
const VISIBLE_FOCUSED = 8;
const VISIBLE_ASKS = 5;

export function statusRow(w: WorkerStatus, width: number, selected: boolean, now: number, theme: Theme, nameWidth: number, frame = 0, idleText?: string, modelMinWidth = 80, tree = "") {
  const t = theme;
  const mark = w.running ? t.fg("accent", SPINNER[frame % SPINNER.length]!) : t.fg("muted", "○");
  const name = truncateToWidth(clean(w.name), nameWidth, "…", true);
  const left = `${selected ? t.fg("accent", "› ") : "  "}${t.fg("dim", tree)}${mark} ${askCount(w, t)}${selected ? t.fg("accent", t.bold(name)) : w.running ? name : t.fg("muted", name)}  `;
  const time = w.running && w.since ? formatDuration(now - w.since)
    : !w.running && w.since && w.finishedAt && w.finishedAt >= w.since ? formatDuration(w.finishedAt - w.since) : "";
  // On narrow terminals the model drops first, then the cost, then the activity text.
  const model = width >= modelMinWidth && w.model ? `${w.model}${w.thinking ? ` ${w.thinking}` : ""}` : "";
  const right = [model, time, formatContext(w), width >= 70 && formatCost(w.cost)].filter(Boolean).join(" · ");
  const showRight = width >= 40 && right;
  const middle = w.running ? w.activity ?? "running"
    : idleText ?? `idle${w.finishedAt ? ` · last reply ${formatAgo(now - w.finishedAt)}` : ""}`;
  const space = width - visibleWidth(left) - (showRight ? visibleWidth(right) + 2 : 0);
  const mid = width >= 60 && space > 4 ? truncateToWidth(w.running ? middle : t.fg("dim", middle), space, "…", true) : " ".repeat(Math.max(0, space));
  return truncateToWidth(`${left}${mid}${showRight ? `  ${t.fg("dim", right)}` : ""}`, width);
}

/**
 * Team panel under the prompt. First the asks waiting on the human (titles), then the team: running
 * workers one per line (animated), the rest summarized. Down from an empty prompt focuses it: every row
 * is selectable, the selected ask shows its full text, Enter answers it or opens the worker.
 * Up past the first row, Esc, or typing returns to the prompt.
 */
/** The open agent's asks for the panel: the list, the draft that may already answer some, and where Enter sends them. */
export type PanelAsks = { list(): Ask[]; draft(): string; cursorLine(): number; answer(ask: Ask): void; prompt: Component };
export class TeamPanel implements Component, Focusable {
  focused = false;
  private workers: WorkerStatus[] = [];
  private asks: Ask[] = [];
  private asksOf?: PanelAsks;
  private selected = 0;
  private frame = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private rows: (WorkerStatus | Ask | "more" | undefined)[] = [];
  private returnTo?: Component;
  private focus: (component: Component) => void;
  private compact: boolean;
  private tui: TUI; private theme: Theme; private onOpen: (worker: WorkerStatus) => void;
  constructor(tui: TUI, theme: Theme, onOpen: (worker: WorkerStatus) => void, options: { compact?: boolean; focus?: (component: Component) => void; asks?: PanelAsks } = {}) { this.tui = tui; this.theme = theme; this.onOpen = onOpen; this.compact = options.compact ?? false; this.focus = options.focus ?? (component => tui.setFocus(component)); this.asksOf = options.asks; }

  get hasWorkers() { return this.workers.length > 0; }
  get hasRows() { return this.workers.length + this.asks.length > 0; }
  /** Open asks, shown above the team; read from `options.asks` on each render. */
  private setAsks(asks: Ask[]) {
    if (JSON.stringify(asks) === JSON.stringify(this.asks)) return;
    const keep = this.selected < this.asks.length ? undefined : this.workers[this.selected - this.asks.length]?.id;
    this.asks = asks;
    const worker = this.workers.findIndex(w => w.id === keep);
    this.selected = worker >= 0 ? asks.length + worker : Math.min(this.selected, Math.max(0, asks.length + this.workers.length - 1));
    if (!this.hasRows && this.focused) this.leave();
  }
  /** Focused component, so the caller can check the main prompt has focus. Not on Pi's public TUI type. */
  currentFocus() { return (this.tui as { getFocusedComponent?: () => unknown }).getFocusedComponent?.(); }
  setWorkers(workers: WorkerStatus[]) {
    const keep = this.workers[this.selected - this.asks.length]?.id;
    const rank = (w: WorkerStatus) => w.running ? 0 : 1;
    this.workers = [...workers].sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 0 ? (a.since ?? 0) - (b.since ?? 0) : (b.finishedAt ?? 0) - (a.finishedAt ?? 0)));
    const index = this.workers.findIndex(w => w.id === keep);
    this.selected = index >= 0 ? this.asks.length + index : Math.min(this.selected, Math.max(0, this.asks.length + this.workers.length - 1));
    if (!this.hasRows && this.focused) this.leave();
    // Animate only running workers.
    const running = this.workers.some(w => w.running);
    if (running && !this.ticker) this.ticker = setInterval(() => { this.frame++; this.tui.requestRender(); }, 100);
    if (!running && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    this.tui.requestRender();
  }
  /** Asks whose "Re:" line is already in the draft: still open until the agent closes them, shown dimmed. */
  private drafted(ask: Ask) { return (this.asksOf?.draft() ?? "").toLowerCase().includes(askReply(ask).trimEnd().toLowerCase()); }
  /** The ask being answered: the nearest "Re:" line at or above the prompt's cursor names it. */
  private editing() {
    const lines = (this.asksOf?.draft() ?? "").split("\n").slice(0, this.asksOf!.cursorLine() + 1).reverse();
    const line = lines.find(line => /^re: /i.test(line))?.toLowerCase();
    return line === undefined ? undefined : this.asks.find(ask => line.startsWith(askReply(ask).trimEnd().toLowerCase()));
  }
  /** Focus the panel: on `target`'s worker, else on the first ask not yet in the draft. */
  enter(editor: Component, target?: string) {
    const worker = this.workers.findIndex(w => w.id === target);
    this.returnTo = editor;
    this.selected = worker >= 0 ? this.asks.length + worker : Math.max(0, this.asks.findIndex(ask => !this.drafted(ask)));
    this.focus(this); this.tui.requestRender();
  }
  private leave(forward?: string) {
    const editor = this.returnTo;
    if (!editor) return;
    this.focus(editor);
    if (forward) editor.handleInput?.(forward);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const t = this.theme;
    const now = Date.now();
    const nameWidth = Math.min(16, Math.max(6, ...this.workers.map(w => visibleWidth(clean(w.name)))));
    if (this.asksOf) this.setAsks(this.asksOf.list());
    this.rows = [];
    if (!this.hasRows) return [];
    const lines: string[] = [];
    const push = (line: string, row?: WorkerStatus | Ask | "more") => { lines.push(line); this.rows.push(row); };
    const askLine = (ask: Ask, selected: boolean) => {
      const title = selected ? t.bold(ask.title) : ask.title;
      const drafted = this.drafted(ask);
      return truncateToWidth(`${selected ? t.fg("accent", "› ") : "  "}${drafted ? t.fg("dim", title) : t.fg("warning", title)}${t.fg("dim", `${drafted ? " · in draft" : ""}${ask.at ? ` · ${formatAgo(now - ask.at)}` : ""}`)}`, width);
    };
    const asked = this.selected < this.asks.length;
    // Leave room for the conversation and prompt on short terminals.
    const visible = Math.max(1, Math.min(VISIBLE_FOCUSED, (this.tui.terminal?.rows ?? 24) - 12));
    const window = <T,>(rows: T[], at: number) => { const start = Math.max(0, Math.min(at - Math.floor(visible / 2), rows.length - visible)); return { start, rows: rows.slice(start, start + visible) }; };
    if (this.focused) {
      const shownAsks = window(this.asks, asked ? this.selected : 0);
      for (const [i, ask] of shownAsks.rows.entries()) {
        const selected = shownAsks.start + i === this.selected;
        push(askLine(ask, selected), ask);
        if (selected && ask.text) for (const line of wrapTextWithAnsi(ask.text, Math.max(10, width - 4))) push(`    ${line}`, ask);
      }
      const worker = this.selected - this.asks.length;
      const shown = window(this.workers, worker);
      for (const [i, w] of shown.rows.entries()) push(statusRow(w, width, shown.start + i === worker, now, t, nameWidth, this.frame), w);
      const more = asked ? (this.asks.length > visible ? `${this.selected + 1}/${this.asks.length} · ` : "")
        : this.compact || this.workers.length > visible ? `${worker + 1}/${this.workers.length} · ` : "";
      push(truncateToWidth(t.fg("dim", `  ${more}↑↓ select · ${asked ? "enter answer" : "enter/→ open"} · esc back`), width));
      return lines;
    }
    // Collapsed: the first titles, plus the ask being answered in the prompt, shown in full.
    const editing = this.asksOf && this.editing();
    const glance = this.asks.slice(0, VISIBLE_ASKS);
    if (editing && !glance.includes(editing)) glance.push(editing);
    for (const ask of glance) {
      push(askLine(ask, false), ask);
      if (ask === editing && ask.text) for (const line of wrapTextWithAnsi(ask.text, Math.max(10, width - 4))) push(`    ${line}`, ask);
    }
    if (this.asks.length > glance.length) push(truncateToWidth(t.fg("dim", `  +${this.asks.length - glance.length} more · ↓`), width), "more");
    if (!this.workers.length) { push(truncateToWidth(t.fg("dim", "  ↓ to select"), width)); return lines; }
    const { shown, summary } = teamGlance(this.workers, this.compact ? Infinity : VISIBLE_RUNNING);
    for (const w of shown) push(statusRow(w, width, false, now, t, nameWidth, this.frame), w);
    push(truncateToWidth(t.fg("dim", `  ${shown.length || summary.includes("team ") ? "" : "team · "}${summary ? `${summary} · ` : ""}↓ to select`), width));
    return lines;
  }
  handleInput(data: string) {
    if (matchesKey(data, Key.up)) { if (this.selected === 0) return this.leave(); this.selected--; }
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.asks.length + this.workers.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter) && this.selected < this.asks.length) return this.answer(this.asks[this.selected]!);
    // As on the dashboard, → opens like Enter and ← goes back (handled by the chat view).
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) { const w = this.workers[this.selected - this.asks.length]; if (w) this.onOpen(w); return; }
    else if (matchesKey(data, Key.escape)) return this.leave();
    else return this.leave(data);
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const row = this.rows[event.y];
    if (!row) return undefined;
    if (row === "more") { if (this.asksOf) this.enter(this.asksOf.prompt); return { handled: true }; }
    if ("entry" in row) { this.answer(row); return { handled: true }; }
    this.selected = this.asks.length + Math.max(0, this.workers.indexOf(row));
    this.onOpen(row);
    return { handled: true };
  }
  /** Back to the prompt, then let the chat add the ask's "Re:" line and show where it was asked. */
  private answer(ask: Ask) { this.leave(); this.asksOf?.answer(ask); }
  invalidate() {}
  dispose() { if (this.ticker) clearInterval(this.ticker); this.ticker = undefined; }
}

/** Pane widths, the same breakpoints as the web app: under 80 columns only the active pane shows; from 140 the main agent's rail too. */
export const RAIL_DASHBOARD_MIN = 80, RAIL_MAIN_MIN = 140;
export const railWidth = (columns: number, share: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(columns * share)));

/**
 * A narrow, read-only column beside the open agent: the dashboard, or the main agent above an open sub-agent.
 * The mouse reaches it, the keyboard never does: clicking the header collapses back to it, clicking a row opens
 * that agent. It fills the screen's height so its right border runs the full column.
 */
export class Rail implements Component {
  private rows: (WorkerStatus | "header" | undefined)[] = [];
  private tui: TUI; private theme: Theme;
  private width: (columns: number) => number;
  private content: (frame: number) => { header: string; lines: { worker?: WorkerStatus; tree?: string; text?: string; open?: boolean }[] };
  private frame: () => number; private onHeader: () => void; private onOpen: (worker: WorkerStatus) => void;
  constructor(tui: TUI, theme: Theme, options: { width: (columns: number) => number; frame: () => number; onHeader: () => void; onOpen: (worker: WorkerStatus) => void;
    content: (frame: number) => { header: string; lines: { worker?: WorkerStatus; tree?: string; text?: string; open?: boolean }[] } }) {
    this.tui = tui; this.theme = theme; this.width = options.width; this.content = options.content;
    this.frame = options.frame; this.onHeader = options.onHeader; this.onOpen = options.onOpen;
  }
  render(available: number): string[] {
    const t = this.theme; const width = Math.min(available, this.width(this.tui.terminal.columns));
    const inner = Math.max(1, width - 2);
    const { header, lines } = this.content(this.frame());
    const out: string[] = []; this.rows = [];
    const push = (text: string, row?: WorkerStatus | "header") => {
      const cut = truncateToWidth(text, inner, "…");
      out.push(`${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${t.fg("borderMuted", "│")}`); this.rows.push(row);
    };
    push(header, "header"); push(t.fg("borderMuted", "─".repeat(inner)));
    for (const { worker, tree = "", text, open } of lines) {
      if (!worker) { push(t.fg("dim", `${tree}${text ?? ""}`)); continue; }
      const mark = worker.running ? t.fg("accent", SPINNER[this.frame() % SPINNER.length]!) : t.fg("muted", "○");
      const name = clean(worker.name);
      push(`${t.fg("dim", tree)}${mark} ${askCount(worker, t)}${open ? t.fg("accent", t.bold(name)) : worker.running ? name : t.fg("muted", name)}`, worker);
    }
    while (out.length < this.tui.terminal.rows) push("");
    return out;
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const row = this.rows[event.y];
    if (row === "header") this.onHeader(); else if (row) this.onOpen(row); else return undefined;
    return { handled: true };
  }
  invalidate() {}
}

/** Shows the first `max` rendered lines and how many are hidden. */
class Clamp implements Component {
  private child: Component; private max: number; private hint: (hidden: number) => string;
  constructor(child: Component, max: number, hint: (hidden: number) => string) { this.child = child; this.max = max; this.hint = hint; }
  render(width: number) {
    const lines = this.child.render(width);
    return lines.length <= this.max ? lines : [...lines.slice(0, this.max), truncateToWidth(this.hint(lines.length - this.max), width)];
  }
  invalidate() { this.child.invalidate(); }
}

/**
 * Click to expand/collapse, like Pi's built-in tool and summary blocks. Ctrl+O still toggles every block;
 * Pi rebuilds the component then, so a click only overrides the global state until the next Ctrl+O.
 */
class ClickToExpand implements Component {
  private expanded: boolean; private build: (expanded: boolean) => Component; private child: Component;
  private region: MouseRegion;
  constructor(expanded: boolean, build: (expanded: boolean) => Component) {
    this.expanded = expanded; this.build = build; this.child = build(expanded);
    this.region = new MouseRegion({ render: width => this.child.render(width), invalidate: () => this.child.invalidate() }, event => this.click(event));
  }
  private click(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.expanded = !this.expanded; this.child = this.build(this.expanded);
    return { handled: true };
  }
  render(width: number) { return this.region.render(width); }
  handleMouse(event: TuiMouseEvent) { return this.region.handleMouse(event); }
  invalidate() { this.child.invalidate(); }
}

/** One Markdown excerpt rule for incoming, outgoing and tool prompts. */
function excerpt(text: string, expanded: boolean, theme: Theme): Component {
  const body = new Markdown(clean(text), 0, 0, getMarkdownTheme(), { color: text => theme.fg("customMessageText", text) });
  return expanded ? body : new Clamp(body, COLLAPSED_LINES, hidden => theme.fg("dim", `… ${hidden} more lines · ${expandKey()} to expand`));
}

/** Incoming report/message card: sender first, bounded literal excerpt, full Markdown on expansion. */
export function renderDelivery(message: { content: unknown; details?: unknown }, { expanded, outputPad }: { expanded: boolean; outputPad: number }, theme: Theme): Component {
  return new ClickToExpand(expanded, value => deliveryCard(message, value, outputPad, theme));
}
function deliveryCard(message: { content: unknown; details?: unknown }, expanded: boolean, outputPad: number, theme: Theme) {
  const box = new Box(outputPad, 1, text => theme.bg("customMessageBg", text));
  const d = message.details as Delivery | undefined;
  const valid = typeof d?.text === "string" && typeof d?.from?.name === "string";
  const raw = typeof message.content === "string" ? message.content : textOf(message);
  const source = d?.from?.role === "main" ? "other session" : "our team";
  box.addChild(new Text(valid
    ? theme.fg("customMessageLabel", theme.bold(clean(d!.from.name))) + theme.fg("dim", ` · ${source}${d!.mode === "steer" ? " · steer" : ""}`)
    : theme.fg("customMessageLabel", theme.bold("Team message")), 0, 0));
  box.addChild(excerpt(valid ? d!.text : raw, expanded, theme));
  if (!expanded) return box;
  if (valid) box.addChild(new Text(theme.fg("dim", `\nfrom ${clean(d!.from.id)} · delivery ${clean(d!.id)}${d!.request ? ` · request ${clean(d!.request)}` : ""}`), 0, 0));
  return box;
}

/** A message the human sent directly from the Team view. Display only; not model context. */
export function renderSent(data: { target: string; mode: Mode; text: string; request?: string } | undefined, expanded: boolean, theme: Theme): Component {
  return new ClickToExpand(expanded, value => sentNote(data, value, theme));
}
function sentNote(data: { target: string; mode: Mode; text: string; request?: string } | undefined, expanded: boolean, theme: Theme) {
  const header = theme.fg("muted", `You → ${clean(data?.target)} · ${data?.mode === "steer" ? "steer" : "follow-up"} · accepted${data?.request ? ` · request ${data.request}` : ""}`);
  const box = new Box(1, 0); box.addChild(new Text(header, 0, 0));
  box.addChild(excerpt(data?.text ?? "", expanded, theme));
  return box;
}

export function renderTeamCall(args: Partial<Action> & { timeoutSeconds?: number }, theme: Theme, context: { expanded: boolean } = { expanded: false }) {
  const subject = args.action === "spawn" ? args.name : args.target ?? "";
  let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", args.action ?? "") + (subject ? ` ${clean(subject)}` : "");
  const extras = [args.timeoutSeconds !== undefined && `remind ${formatDuration(args.timeoutSeconds * 1000)}`, args.mode === "steer" && "steer", args.scope === "mains" && "sessions", args.transcript && "transcript", args.request && `request ${args.request}`].filter(Boolean);
  if (extras.length) text += theme.fg("muted", ` · ${extras.join(" · ")}`);
  const box = new Box(0, 0);
  box.addChild(new Text(text, 0, 0));
  if (args.message) box.addChild(excerpt(args.message, context.expanded, theme));
  return box;
}

/** One-line receipts; the raw JSON stays available on expansion. */
export function teamResultSummary(args: Partial<Action>, details: any): string {
  if (args.action === "list") {
    if (!Array.isArray(details)) return "";
    const lines = (rows: any[], indent: string): string[] => rows.flatMap(a => a.id === undefined ? [`${indent}${clean(a.summary)}`]
      : [`${indent}${clean(a.name)} · ${clean(a.status)}`, ...lines(a.children ?? [], `${indent}  `), ...(a.summary ? [`${indent}  ${clean(a.summary)}`] : [])]);
    return lines(details, "").join("\n") || "no agents";
  }
  if (args.action === "spawn" || args.action === "send") {
    if (details?.taskId !== undefined) return `accepted · request ${details.taskId} · report arrives automatically`;
    if (details?.delivery) return "accepted · queued for that session";
    return "accepted";
  }
  if (args.action === "abort") return `aborted ${details?.aborted?.length ?? 0} agent(s)`;
  if (args.action === "inspect") {
    if (args.request) {
      const state = details?.state;
      const status = state?.status === "terminal" ? state.outcome?.status : state?.status;
      const answer = firstLine(textOf(details?.answer));
      return `request ${details?.request} · ${status ?? "unknown"}${answer ? `\n${answer}` : ""}`;
    }
    if (args.transcript) return `${details?.items?.length ?? 0} items${details?.next ? " · older pages available" : ""}`;
    const latest = firstLine(details?.latest);
    const head = details?.role === "main" ? "latest publication · may be stale" : clean(details?.status);
    return `${head}${latest ? `\n${latest}` : ""}`;
  }
  return "";
}

export function renderTeamResult(result: { content: any[]; details?: unknown }, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme, context: { args: Partial<Action>; isError: boolean }) {
  if (isPartial) return new Text(theme.fg("muted", "…"), 0, 0);
  const raw = clean(result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"));
  if (context.isError) return new Text(theme.fg("error", raw), 0, 0);
  let summary = "";
  try { summary = teamResultSummary(context.args, result.details); } catch { /* raw fallback */ }
  if (expanded || !summary) return new Text(theme.fg("toolOutput", raw), 0, 0);
  const [head, ...rest] = summary.split("\n");
  return new Text([theme.fg("success", head!), ...rest.map(line => theme.fg("muted", truncateToWidth(line, 200)))].join("\n"), 0, 0);
}

export type TranscriptOptions = { showThinking?: boolean; expanded?: boolean; tui?: TUI; cwd?: string; showImages?: boolean; images?: (entryId: string) => ImageContent[] | undefined };

/** Worker transcript as terminal lines, oldest first, drawn like Pi's chat: inputs on Pi's message
 * backgrounds, tool calls by Pi's own tool component and renderers, replies plain. */
export function renderTranscript(items: ChatItem[], worker: string, width: number, theme: Theme, { showThinking = false, expanded = false, tui, cwd = process.cwd(), showImages = false, images }: TranscriptOptions = {}): string[] {
  const results = new Map(items.filter(item => item.kind === "result").map(item => [item.callId, item]));
  const md = getMarkdownTheme();
  const out: string[] = [];
  const block = (lines: string[]) => { if (lines.length) out.push("", ...lines); };
  const card = (bg: ThemeBg, ...children: Component[]) => {
    const box = new Box(1, 1, text => theme.bg(bg, text));
    for (const child of children) box.addChild(child);
    return box.render(width);
  };
  const markdown = (text: string, style?: DefaultTextStyle) => new Markdown(clean(text), 1, 0, md, style);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const ui = tui ?? ({ requestRender() {} } as unknown as TUI);
  for (const item of [...items].sort((a, b) => Number(a.id) - Number(b.id))) {
    if (item.kind === "input") {
      // Pi's user message; reports take Pi's custom-message colours.
      const [bg, label, text] = item.report ? ["customMessageBg", "customMessageLabel", "customMessageText"] as const : ["userMessageBg", "accent", "userMessageText"] as const;
      block(card(bg, new Text(theme.fg(label, theme.bold(`${clean(item.from)} → ${worker}`)) + (item.report ? theme.fg("dim", " · report") : ""), 0, 0),
        new Markdown(clean(item.text) + (item.images?.length ? "\n" + item.images.map(() => "[image]").join("\n") : ""), 0, 0, md, { color: t => theme.fg(text, t) })));
    } else if (item.kind === "reply") {
      for (const part of item.parts) {
        if (part.type === "text") { if (part.text.trim()) block(markdown(part.text).render(width)); }
        else if (part.type === "thinking") {
          if (part.text.trim()) block((showThinking ? markdown(part.text, { color: t => theme.fg("thinkingText", t), italic: true })
            : new Text(theme.italic(theme.fg("thinkingText", `Thinking · ${part.text.split("\n").length} lines`)), 1, 0)).render(width));
        } else {
          // Pi's own tool component. An empty definition gives unknown tools Pi's bounded generic preview.
          const renderers = part.name === "team" ? { renderCall: renderTeamCall, renderResult: renderTeamResult } : builtInRenderers(part.name) ?? {};
          // A host older than tool args sends only the subject: the path, or the command for shells.
          const args = part.args ?? { [["bash", "powershell"].includes(part.name) ? "command" : "path"]: part.subject };
          const tool = new ToolExecutionComponent(part.name, part.id, args, { showImages }, renderers as any, ui, cwd);
          tool.setExpanded(expanded);
          const result = results.get(part.id);
          if (result) {
            const content = result.content ?? (result.error ? [{ type: "text", text: result.error }] : []);
            const loaded = showImages && content.some(part => part.type === "image") ? images?.(result.id) : undefined;
            tool.updateResult({ content: loaded ? [...content.filter(part => part.type !== "image"), ...loaded] : content,
              details: result.details, isError: !result.ok, ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }) });
          }
          out.push(...tool.render(width)); // starts with its own blank line
        }
      }
      if (item.error) block(new Text(theme.fg("error", item.error), 1, 0).render(width));
      if (item.turn) {
        const parts = [item.at !== undefined && clock(item.at), item.turn.ms !== undefined && formatDuration(item.turn.ms), item.turn.tokens && `${formatTokens(item.turn.tokens)} tok`, formatCost(item.turn.cost)];
        block(new Text(theme.fg("dim", parts.filter(Boolean).join(" · ")), 1, 0).render(width));
      }
    } else if (item.kind === "notice") block(new Text(theme.fg(item.warning ? "warning" : "dim", item.text), 1, 0).render(width));
    else if (item.kind === "compaction") {
      // Pi's compaction message: collapsed to its token count, the summary on ctrl+o.
      const message = new CompactionSummaryMessageComponent({ summary: clean(item.summary), tokensBefore: item.tokensBefore ?? 0 } as any, md);
      message.setExpanded(expanded);
      block(message.render(width));
    }
  }
  return out[0] === "" ? out.slice(1) : out;
}

export type WorkerSource = {
  images(entryId: string): Promise<ImageContent[]>;
  page(cursor?: string): Promise<{ conversationId?: string; items: ChatItem[]; queued?: Queued[]; next?: string }>;
  status(): Promise<WorkerStatus>;
  watch(signal: AbortSignal, onFrame: () => void): Promise<void>;
};

export type ChatActions = {
  send(text: string, mode: Mode, images?: ImageContent[]): Promise<unknown>; stop(): Promise<unknown>; back(): void;
  /** `/compact [instructions]` in the editor. */
  models?(): Promise<ModelChoice[]>;
  setModel?(model: ModelChoice, thinking: ModelThinkingLevel): Promise<unknown>;
  compact?(instructions: string): Promise<{ outcome: "compacted" | "nothing" | "running" | "failed"; error?: string }>;
  /** `/fork`, `/clone` and `/new`, top-level agents only: the human's messages, and a fork before one of them, of everything or (NEW) of nothing. */
  inputs?(): Promise<{ id: string; text: string }[]>;
  fork?(before?: string, draft?: string): Promise<unknown>;
  tree?(entryId?: string): Promise<TreeResult>;
  /** Pi's alt+up: queued messages taken back for editing. */
  dequeue?(): Promise<{ texts: string[] }>;
  doubleEscapeAction?: "tree" | "fork" | "none";
};

/** Shared committed transcript, loading, watch and paging for both shells. */
class Transcript implements Component {
  entries = new Map<string, ChatItem>();
  private conversationId?: string;
  next?: string;
  private olderLoaded = false;
  status?: WorkerStatus;
  connection: "loading" | "live" | "stale" = "loading";
  note?: string;
  offset = 0; // lines scrolled up from the bottom; 0 follows live activity
  unseen = false;
  // Pi's hideThinkingBlock (default off): thinking text is shown; ctrl+t hides it.
  showThinking = !SettingsManager.create(homedir(), agentDir).getHideThinkingBlock();
  expanded = false; // Pi's ctrl+o: full tool output
  queued: Queued[] = [];
  /** What the human just started and the host has not finished, shown at once like Pi's status spinner. */
  pending?: string;
  /** Pi's pending-message lines above the editor: messages waiting for the agent's next boundary. */
  queuedLines(width: number) {
    if (!this.queued.length) return [];
    return ["", ...this.queued.map(q => truncateToWidth(` ${this.theme.fg("dim", `${q.mode === "steer" ? "Steering" : "Follow-up"}: ${q.text}`)}`, width)),
      truncateToWidth(` ${this.theme.fg("dim", `↳ ${keyText("app.message.dequeue")} to edit all queued messages`)}`, width)];
  }
  private cache?: { width: number; version: number; lines: string[] };
  version = 0;
  private lastLength?: { width: number; length: number };
  private prepended = false;
  private life = new AbortController();
  private refreshing?: Promise<void>;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private parent: AbortSignal;
  private onParentAbort = () => this.dispose();
  private loader?: Loader;
  private showWorking: boolean;
  private clockTimer?: ReturnType<typeof setInterval>; // ticks the "working" time while the worker runs

  tui: TUI; theme: Theme; name: string; source: WorkerSource;
  constructor(tui: TUI, theme: Theme, name: string, source: WorkerSource, parent: AbortSignal, showWorking = false) {
    this.showWorking = showWorking;
    this.tui = tui; this.theme = theme; this.name = name; this.source = source;
    this.parent = parent;
    parent.addEventListener("abort", this.onParentAbort, { once: true });
    void this.refresh().then(() => this.attach());
    void loadToolRenderers().then(() => { this.version++; this.changed(); });
  }
  attach() {
    if (this.life.signal.aborted) return;
    this.connection = "live"; this.changed();
    this.source.watch(this.life.signal, () => this.schedule()).then(
      () => { if (!this.life.signal.aborted) { this.connection = "stale"; this.changed(); } },
      () => { if (!this.life.signal.aborted) { this.connection = "stale"; this.changed(); } },
    );
  }
  schedule() {
    if (this.timer || this.life.signal.aborted) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250);
  }
  refresh(): Promise<void> {
    if (this.refreshing) { this.dirty = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.dirty = false;
        try {
          const [page, status] = await Promise.all([this.source.page(), this.source.status()]);
          if (this.life.signal.aborted) return;
          // A newest page that shares nothing with what is loaded left a gap: start over from it, as the web does.
          if (page.conversationId !== this.conversationId || (this.entries.size && !page.items.some(entry => this.entries.has(String(entry.id))))) {
            this.imageCache = new Map(); this.entries.clear(); this.olderLoaded = false; this.next = undefined; this.offset = 0;
            this.conversationId = page.conversationId;
          }
          for (const entry of page.items) this.entries.set(String(entry.id), entry);
          this.queued = page.queued ?? [];
          if (!this.olderLoaded) this.next = page.next;
          this.status = status; this.note = undefined; this.version++;
          this.updateWorking();
          if (status.running && !this.clockTimer) this.clockTimer = setInterval(() => { this.updateWorking(); this.tui.requestRender(); }, 1000);
          if (!status.running && this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = undefined; }
        } catch (error) {
          if (this.life.signal.aborted) return;
          this.note = error instanceof Error ? error.message : String(error);
        }
        this.changed();
      } while (this.dirty && !this.life.signal.aborted);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  updateWorking() {
    const s = this.status;
    if (!this.showWorking || (!s?.running && !this.pending)) { this.loader?.stop(); this.loader = undefined; return; }
    this.loader ??= new Loader(this.tui, text => this.theme.fg("accent", text), text => this.theme.fg("muted", text));
    // As Pi: just "Working", since the transcript above already shows the running tool call.
    this.loader.setMessage(this.pending ?? `Working · ${formatDuration(s!.since === undefined ? 0 : Date.now() - s!.since)} (esc to stop)`);
  }
  workingLine(width: number) { return this.loader?.render(width) ?? []; }
  private loadingOlder = false;
  /** Lines the last older page added above the top, for a scroll view to keep its place. */
  grewAtTop = 0;
  async older() {
    if (!this.next) { this.note = "start of transcript"; this.changed(); return; }
    if (this.loadingOlder) return;
    this.loadingOlder = true;
    const conversation = this.conversationId;
    try {
      const page = await this.source.page(this.next);
      if (this.life.signal.aborted || conversation !== this.conversationId) return;
      for (const entry of page.items) this.entries.set(String(entry.id), entry);
      this.next = page.next; this.olderLoaded = true; this.prepended = true; this.version++;
    } catch (error) { this.note = String(error); }
    finally { this.loadingOlder = false; }
    this.changed();
  }
  changed() { this.cache = undefined; this.tui.requestRender(); }
  toggleThinking() { this.showThinking = !this.showThinking; this.version++; this.changed(); }
  /** Pi's keys: ctrl+o expands tool output, ctrl+t shows thinking. */
  toggle(data: string) {
    const keys = getKeybindings();
    if (keys.matches(data, "app.tools.expand")) { this.expanded = !this.expanded; this.version++; this.changed(); return true; }
    if (keys.matches(data, "app.thinking.toggle")) { this.toggleThinking(); return true; }
    return false;
  }
  private imageCache = new Map<string, ImageContent[] | undefined>();
  private images = (entryId: string) => {
    if (!this.imageCache.has(entryId)) {
      this.imageCache.set(entryId, undefined);
      const cache = this.imageCache;
      void this.source.images(entryId).then(images => {
        if (this.life.signal.aborted || cache !== this.imageCache) return;
        cache.set(entryId, images); this.version++; this.changed();
      }).catch(() => { /* Keep Pi's image fallback on failure. */ });
    }
    return this.imageCache.get(entryId);
  };
  private render_(entries: ChatItem[], width: number) {
    return renderTranscript(entries, this.name, width, this.theme, { showThinking: this.showThinking, expanded: this.expanded, tui: this.tui, cwd: this.status?.cwd, showImages: SettingsManager.create(this.status?.cwd ?? homedir(), agentDir).getShowImages(), images: this.images });
  }
  lines(width: number) {
    if (this.cache?.width !== width || this.cache.version !== this.version) {
      this.cache = { width, version: this.version, lines: this.render_([...this.entries.values()], width) };
    }
    const lines = this.cache.lines;
    // Keep a scrolled-up view anchored when activity is appended; prepending older pages needs no shift.
    if (this.lastLength?.width === width && lines.length !== this.lastLength.length && !this.prepended && this.offset > 0) {
      this.offset += lines.length - this.lastLength.length;
      if (lines.length > this.lastLength.length) this.unseen = true;
    }
    if (this.prepended && this.lastLength?.width === width) this.grewAtTop += lines.length - this.lastLength.length;
    this.prepended = false; this.lastLength = { width, length: lines.length };
    // A new agent's conversation has only setup entries: say what to do instead of a blank screen.
    if (!lines.length && this.connection !== "loading" && !this.note) return [this.theme.fg("muted", "No messages yet · type a task and press enter · ← back")];
    return lines;
  }
  // Header, two rules and the key line always fit; the details line only when there is room for a body too.
  showDetails() { return this.tui.terminal.rows >= 8; }
  bodyHeight() { return Math.max(0, this.tui.terminal.rows - (this.showDetails() ? 5 : 4)); }
  /** Model, time, context use, cost and cwd, from the latest committed status. */
  details(now: number) {
    const s = this.status;
    if (!s) return "";
    const time = s.running && s.since ? `working ${formatDuration(now - s.since)}`
      : [s.since && s.finishedAt && s.finishedAt >= s.since && `last request ${formatDuration(s.finishedAt - s.since)}`,
        !s.archived && s.finishedAt && `idle ${formatDuration(now - s.finishedAt)}`].filter(Boolean).join(" · ");
    const cwd = s.cwd ? formatCwd(s.cwd) : "";
    return [s.model && `${s.model}${s.thinking ? ` ${s.thinking}` : ""}`, time, formatContext(s), formatCost(s.cost), cwd].filter(Boolean).join(" · ");
  }

  /** The first line of `entry` in the last rendered lines, loading older pages until it is there. */
  async lineOf(entry: string) {
    const width = this.lastLength?.width ?? this.tui.terminal.columns;
    while (!this.entries.has(entry) && this.next && !this.life.signal.aborted) await this.older();
    if (!this.entries.has(entry)) return undefined;
    const before = [...this.entries.values()].filter(item => Number(item.id) < Number(entry));
    return this.render_(before, width).length + (before.length ? 1 : 0);
  }
  render(width: number) { return this.lines(width); }
  invalidate() { this.cache = undefined; }
  dispose() {
    this.loader?.stop(); this.loader = undefined;
    this.life.abort(); if (this.timer) clearTimeout(this.timer);
    if (this.clockTimer) clearInterval(this.clockTimer); this.clockTimer = undefined;
    this.parent.removeEventListener("abort", this.onParentAbort);
  }
}

/** Pi's full-screen inspector; its keys and bounded viewport stay unchanged. */
export class WorkerView implements Component {
  private transcript: Transcript;
  private done: (result: ViewResult) => void;
  constructor(tui: TUI, theme: Theme, name: string, source: WorkerSource, done: (result: ViewResult) => void, parent: AbortSignal) {
    this.transcript = new Transcript(tui, theme, name, source, parent); this.done = done;
  }
  render(width: number): string[] {
    const t = this.transcript.theme;
    const lines = this.transcript.lines(width);
    const height = this.transcript.bodyHeight();
    this.transcript.offset = Math.max(0, Math.min(this.transcript.offset, lines.length - height));
    if (this.transcript.offset === 0) this.transcript.unseen = false;
    const end = lines.length - this.transcript.offset;
    const visible = lines.slice(Math.max(0, end - height), end);
    const status = this.transcript.status;
    const word = status ? statusWord(status) : "…";
    const color = !status ? "muted" : status.archived ? "warning" : status.running ? "accent" : "muted";
    const connection = this.transcript.connection === "live" ? t.fg("success", "live") : this.transcript.connection === "stale" ? t.fg("warning", "stale · r to refresh") : t.fg("muted", "loading");
    const top = this.transcript.next ? t.fg("dim", " · older pages: o") : "";
    const header = `${t.fg("accent", t.bold(this.transcript.name))}${t.fg("dim", " · ")}${t.fg(color, word)}${t.fg("dim", " · ")}${connection}${top}`;
    const rule = t.fg("borderMuted", "─".repeat(Math.max(0, width)));
    const hints = [this.transcript.unseen && t.fg("accent", "↓ new activity · end"), this.transcript.note && t.fg("warning", this.transcript.note),
      t.fg("dim", `esc back · f follow-up · s steer · x abort · ↑↓ pgup/pgdn scroll · o older · t thinking · ${keyText("app.tools.expand")} expand · r refresh`)].filter(Boolean).join(t.fg("dim", " · "));
    const empty = this.transcript.entries.size ? [] : [t.fg("muted", this.transcript.note ? "" : "Loading transcript…")];
    const filled = [...Array(Math.max(0, height - visible.length - empty.length)).fill(""), ...empty, ...visible];
    const body = height ? filled.slice(-height) : [];
    const heading = this.transcript.showDetails() ? [header, t.fg("dim", this.transcript.details(Date.now()))] : [header];
    return [...heading, rule, ...body, rule, hints].map(line => truncateToWidth(line, width));
  }
  handleInput(data: string) {
    const page = Math.max(1, this.transcript.bodyHeight() - 2);
    if (matchesKey(data, Key.escape) || data === "q") return this.done({ type: "back" });
    if (data === "f") return this.done({ type: "send", mode: "followUp" });
    if (data === "s") return this.done({ type: "send", mode: "steer" });
    if (data === "x") return this.done({ type: "abort" });
    if (data === "o") return void this.transcript.older();
    if (data === "r") { if (this.transcript.connection === "stale") this.transcript.attach(); return void this.transcript.refresh(); }
    if (data === "t" || this.transcript.toggle(data)) { if (data === "t") this.transcript.toggleThinking(); return; }
    if (matchesKey(data, Key.up) || data === "k") this.transcript.offset += 1;
    else if (matchesKey(data, Key.down) || data === "j") this.transcript.offset -= 1;
    else if (matchesKey(data, Key.pageUp)) this.transcript.offset += page;
    else if (matchesKey(data, Key.pageDown)) this.transcript.offset -= page;
    else if (matchesKey(data, Key.home) || data === "g") this.transcript.offset = Number.MAX_SAFE_INTEGER;
    else if (matchesKey(data, Key.end) || data === "G") this.transcript.offset = 0;
    else return;
    this.transcript.offset = Math.max(0, this.transcript.offset);
    this.transcript.tui.requestRender();
  }
  refresh() { return this.transcript.refresh(); }
  invalidate() { this.transcript.invalidate(); }
  dispose() { this.transcript.dispose(); }
}

/** Pi's transcript ScrollView, plus paging: reaching the top loads the previous page, and the lines it
 * adds above keep the visible ones in place, so scrolling continues back to the first message. */
class HistoryScroll extends ScrollView {
  private transcript: Transcript;
  /** A line to show at the top once the next layout knows the content height (pages just loaded would clamp it). */
  private jump?: number;
  constructor(transcript: Transcript) { super(transcript, { follow: "end", primary: true }); this.transcript = transcript; }
  jumpTo(line: number) { this.jump = line; }
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void) {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    const added = this.transcript.grewAtTop; this.transcript.grewAtTop = 0;
    if (this.jump !== undefined) { this.scrollTo(this.jump); this.jump = undefined; }
    else if (added > 0 && !this.isFollowingEnd) this.scrollTo(this.scrollTop + added);
    if (this.scrollTop === 0 && this.transcript.next && this.transcript.connection !== "loading") void this.transcript.older();
  }
}

/** Standalone chat shell. The alternate-screen TUI owns layout and scrolling. */
export class ChatView implements Component, Focusable {
  get focused() { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value && !this.panel?.focused; }
  private transcript: Transcript;
  private editor: Editor;
  private actions: ChatActions;
  private modelNote?: string;
  private disposed = false;
  private panel?: TeamPanel;
  private picker?: { component: Component; input(data: string): void; dispose?(): void };
  private editingExternally = false;
  private tui: TUI;
  private lastEscapeTime = 0;
  private inFlight = 0;
  private scroll: HistoryScroll;
  readonly layout: VStack;
  constructor(tui: TUI, theme: Theme, name: string, source: WorkerSource, parent: AbortSignal, actions: ChatActions, notice: () => string = () => "", children?: { open(worker: WorkerStatus): void }, branch: () => string = () => "", path: () => string = () => "") {
    this.actions = actions;
    this.tui = tui;
    this.transcript = new Transcript(tui, theme, name, source, parent, true);
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.setAutocompleteProvider(promptAutocomplete(() => this.transcript.status?.cwd ?? homedir()));
    this.editor.onSubmit = text => this.submit(text, "steer");
    if (children) this.panel = new TeamPanel(tui, theme, children.open, { compact: true, focus: component => {
      this.panel!.focused = component === this.panel;
      this.editor.focused = component !== this.panel;
    }, asks: { list: () => this.transcript.status?.asks ?? [], draft: () => this.editor.getText(), cursorLine: () => this.editor.getCursor().line, answer: ask => void this.answer(ask), prompt: this.editor } });
    const scroll = new HistoryScroll(this.transcript);
    const footer = { render: (width: number) => {
      const s = this.transcript.status;
      const cwd = s?.cwd ? formatCwd(s.cwd) : "";
      const time = s?.running ? `working${s.since ? ` ${formatDuration(Date.now() - s.since)}` : ""}` : s ? statusWord(s) : "idle";
      const suffix = `${branch() ? ` (${branch()})` : ""} • ${s?.asks?.length ? `${s.asks.length} waiting on you · ` : ""}${s?.name ?? name} · ${time}`;
      const location = truncateToWidth(cwd, Math.max(0, width - visibleWidth(suffix))) + suffix;
      const stats = formatUsage(s);
      const model = s?.modelId ?? s?.model;
      const right = model ? `${s?.provider ? `(${s.provider}) ` : ""}${model}${s?.thinking ? ` • ${s.thinking}` : ""}` : "";
      // Keep a useful stats prefix; omit the model rather than showing a fragment of its ID.
      const room = width - visibleWidth(right) - 2;
      const left = truncateToWidth(stats, right && room >= 24 ? room : width);
      const statsLine = right && room >= 24 ? left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right : left;
      const hints = `${path() || s?.name || name} · ${s?.id ?? "…"} · ← back · esc stop · ${keyText("app.message.followUp")} follow-up · ${keyText("app.tools.expand")} ${this.transcript.expanded ? "collapse" : "expand"} · ${keyText("app.thinking.toggle")} thinking`;
      return [location, statsLine, [hints, this.transcript.note, notice()].filter(Boolean).join(" · ")].map(line => truncateToWidth(theme.fg("dim", line), width));
    }, invalidate() {} };
    const working = { render: (width: number) => [...this.transcript.queuedLines(width), ...this.transcript.workingLine(width), ...(this.modelNote ? [truncateToWidth(theme.fg("muted", this.modelNote), width)] : [])], invalidate() {} };
    // Pi's selectors take the editor's place while open.
    const input = { render: (width: number) => (this.picker?.component ?? this.editor).render(width), invalidate: () => this.editor.invalidate() };
    this.scroll = scroll;
    this.layout = new VStack([{ component: scroll, grow: 1, basis: 0 }, working, input, ...(this.panel ? [this.panel] : []), footer]);
  }
  /** An ask chosen under the prompt: add its "Re:" line to the end of the draft and scroll to where it was asked. */
  private async answer(ask: Ask) {
    const text = this.editor.getText(); const reply = askReply(ask);
    if (!text.includes(reply)) this.editor.setText(text.trimEnd() + (text.trim() ? "\n" : "") + reply);
    const line = await this.transcript.lineOf(ask.entry);
    if (line !== undefined && !this.disposed) { this.scroll.jumpTo(line); this.tui.requestRender(); }
  }
  /** Text for the editor, as Pi restores a forked message. */
  setDraft(text: string) { this.editor.setText(text); }
  /** The unsent prompt, kept per agent while other panes are open. */
  draft() { return this.editor.getText(); }
  /** The markdown of every loaded message and answer, oldest first: what a terminal selection is copied from. */
  markdown() {
    return [...this.transcript.entries.values()].flatMap(item => item.kind === "input" ? [item.text]
      : item.kind === "reply" ? item.parts.flatMap(part => part.type === "tool" ? [] : [part.text]) : []);
  }
  /** Run a host request behind Pi's status spinner, then show its outcome as the footer note. */
  private run<T>(label: string, request: Promise<T>, done: (value: T) => string | undefined) {
    const t = this.transcript;
    this.inFlight++;
    t.pending = label; t.note = undefined; t.updateWorking(); t.changed();
    void request.then(value => { t.note = done(value); }, error => { t.note = error instanceof Error ? error.message : String(error); })
      .finally(() => { this.inFlight--; t.pending = undefined; t.updateWorking(); t.changed(); void t.refresh(); });
  }
  /** `/fork`: Pi's message selector; the chosen message returns to the forked agent's editor. */
  private async showForkPicker() {
    let inputs: { id: string; text: string }[];
    this.inFlight++;
    try { inputs = await this.actions.inputs!(); } catch (error) { this.transcript.note = String(error); this.transcript.changed(); return; }
    finally { this.inFlight--; }
    if (!inputs.length) { this.transcript.note = "No messages to fork from"; this.transcript.changed(); return; }
    const close = () => { this.picker = undefined; this.transcript.changed(); };
    const selector = new UserMessageSelectorComponent(inputs, id => {
      close();
      this.run("Forking…", this.actions.fork!(id, inputs.find(input => input.id === id)?.text ?? ""), () => undefined);
    }, close);
    this.picker = { component: selector, input: data => selector.getMessageList().handleInput(data) };
    this.transcript.changed();
  }
  private async openExternalEditor() {
    if (this.editingExternally) return;
    this.editingExternally = true;
    const content = this.editor.getExpandedText();
    this.tui.stop();
    try {
      const command = SettingsManager.create(this.transcript.status?.cwd ?? homedir(), agentDir).getExternalEditorCommand();
      const result = await piExternalEditor(command, content);
      if (result.status === "complete") this.editor.setText(result.content);
      else this.transcript.note = "External editor failed";
    } catch (error) { this.transcript.note = String(error); }
    finally { this.editingExternally = false; this.tui.start(); this.tui.requestRender(true); }
  }
  private async changeModel(command = "", backwards = false, thinking = false, selectThinking = false) {
    this.inFlight++;
    const t = this.transcript;
    try {
      const choices = await this.actions.models!();
      if (this.disposed) return;
      const current: { provider?: string; modelId?: string; thinking?: string } = t.status ?? {};
      const apply = async (model: ModelChoice, level = modelThinking(model, current.thinking), notice = modelNotice(model, level)) => {
        this.inFlight++;
        try { await this.actions.setModel!(model, level as ModelThinkingLevel); }
        finally { this.inFlight--; }
        if (this.disposed) return;
        this.modelNote = notice; t.changed(); void t.refresh();
      };
      if (thinking) {
        const model = choices.find(m => m.provider === current.provider && m.modelId === current.modelId);
        if (!model) throw new Error("Current model unavailable");
        if (selectThinking && !command) {
          const close = () => { this.picker = undefined; t.changed(); };
          const selector = await piThinkingSelector(current.thinking ?? "off", model.thinkingLevels, level => {
            close(); void apply(model, level, `Thinking level: ${level}`).catch(error => { t.note = String(error); t.changed(); });
          }, close);
          if (this.disposed) return;
          selector.focused = true;
          this.picker = { component: selector, input: data => selector.handleInput(data) };
          t.changed(); return;
        }
        const level = thinkingSelection(model, current.thinking, command);
        if (level) await apply(model, level, `Thinking level: ${level}`);
        else { this.modelNote = "Current model does not support thinking"; t.changed(); }
      } else if (command === "cycle") {
        const model = nextModel(choices, current, backwards);
        if (model) { const level = modelThinking(model, current.thinking, true); await apply(model, level, modelNotice(model, level, true)); }
        else { this.modelNote = choices.some(m => m.scoped) ? "Only one model in scope" : "Only one model available"; t.changed(); }
      } else {
        const model = command && choices.find(m => `${m.provider}/${m.modelId}` === command || m.modelId === command);
        if (model) { await apply(model); return; }
        const close = () => { this.picker?.dispose?.(); this.picker = undefined; t.changed(); };
        const selector = await piModelSelector(t.tui, choices, current, () => this.actions.models!(), model => {
          close(); void apply(model).catch(error => { t.note = String(error); t.changed(); });
        }, close, command);
        if (this.disposed) { selector.dispose(); return; }
        selector.focused = true;
        this.picker = { component: selector, input: data => selector.handleInput(data), dispose: () => selector.dispose() };
        t.changed();
      }
    } catch (error) { t.note = String(error); t.changed(); }
    finally { this.inFlight--; }
  }
  /** Reuse Pi's actual tree component; the host supplies the session projection. No branch summary. */
  private async showTreePicker() {
    this.inFlight++;
    try {
      const tree = await this.actions.tree!();
      if (!tree.nodes.length) throw new Error("No entries in session");
      const Selector = await piTreeSelector();
      const close = () => { this.picker = undefined; this.transcript.changed(); };
      const selector = new Selector(tree.nodes, tree.leafId, this.transcript.tui.terminal.rows, (id: string) => {
        close();
        if (id === tree.leafId) return;
        this.run("Navigating tree…", this.actions.tree!(id), result => {
          if (result.editorText !== undefined && !this.editor.getText().trim()) this.editor.setText(result.editorText);
          return "Navigated to selected point";
        });
      }, close, () => { this.transcript.note = "Labels are not supported"; this.transcript.changed(); });
      selector.focused = true;
      this.picker = { component: selector, input: data => selector.handleInput(data) };
      this.transcript.changed();
    } catch (error) { this.transcript.note = String(error); this.transcript.changed(); }
    finally { this.inFlight--; }
  }
  setChildren(workers: WorkerStatus[]) { this.panel?.setWorkers(workers); }
  focusChild(target: string) { this.panel?.enter(this.editor, target); }
  private submit(text: string, mode: Mode) {
    if (!text.trim()) return;
    this.modelNote = undefined;
    const command = text.trim();
    if (this.actions.models && /^\/(model|thinking)(?:\s|$)/.test(command)) {
      this.editor.setText(""); this.editor.addToHistory(text);
      const thinking = command.startsWith("/thinking");
      void this.changeModel(command.slice(thinking ? 9 : 6).trim(), false, thinking, thinking); return;
    }
    if (this.actions.compact && /^\/compact(?:\s|$)/.test(command)) {
      this.editor.setText(""); this.editor.addToHistory(text);
      this.run("Compacting context…", this.actions.compact(command.slice("/compact".length).trim()), result =>
        result.outcome === "compacted" ? "Context compacted" : result.outcome === "nothing" ? "Nothing to compact yet"
          : result.outcome === "running" ? "Still compacting in the background" : `Compaction failed: ${result.error}`);
      return;
    }
    if (this.actions.tree && command === "/tree") {
      this.editor.setText(""); void this.showTreePicker(); return;
    }
    if (this.actions.fork && (command === "/fork" || command === "/clone" || command === "/new")) {
      this.editor.setText("");
      if (command === "/clone") this.run("Cloning…", this.actions.fork(), () => undefined);
      else if (command === "/new") this.run("Starting a new agent…", this.actions.fork(NEW), () => undefined);
      else void this.showForkPicker();
      return;
    }
    this.editor.setText("");
    this.transcript.note = `${mode === "steer" ? "Steering" : "Follow-up"}: ${firstLine(text)}`;
    this.transcript.changed();
    this.inFlight++;
    void this.actions.send(text, mode).then(() => { this.editor.addToHistory(text); this.transcript.note = undefined; this.transcript.changed(); }, error => {
      if (!this.editor.getText()) this.editor.setText(text);
      this.transcript.note = String(error); this.transcript.changed();
    }).finally(() => { this.inFlight--; });
  }
  private async pasteClipboard() {
    try {
      const clipboard = await piClipboard();
      const paths = await clipboard.readClipboardFilePaths();
      if (paths) {
        if (paths.some((path: string) => /\p{Cc}/u.test(path))) throw new Error("Clipboard file path contains control characters");
        const cursor = this.editor.getCursor();
        const line = this.editor.getText().split("\n")[cursor.line] ?? "";
        const before = line[cursor.col - 1]; const after = line[cursor.col];
        this.editor.insertTextAtCursor(`${before && !/\s/.test(before) ? " " : ""}${paths.join("\n")}${after && !/\s/.test(after) ? " " : ""}`);
      } else {
        const image = await clipboard.readClipboardImage();
        if (image) {
          const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${clipboard.extensionForImageMimeType(image.mimeType) ?? "png"}`);
          await writeFile(path, image.bytes);
          this.editor.insertTextAtCursor(path);
        } else {
          const text = await clipboard.readClipboardText();
          if (text) this.editor.insertTextAtCursor(text);
        }
      }
    } catch (error) { this.transcript.note = `Failed to paste from clipboard: ${error}`; }
    this.transcript.changed();
  }
  render(width: number) { return this.layout.render(width); }
  /** Down leaves the prompt from its last line, unless Pi's prompt history is being browsed (Down steps forward there). */
  private atPromptEnd() {
    if ((this.editor as unknown as { historyIndex: number }).historyIndex > -1) return false;
    return this.editor.getCursor().line >= this.editor.getLines().length - 1;
  }
  handleInput(data: string) {
    if (this.editingExternally) return;
    if (this.picker) { this.picker.input(data); this.transcript.changed(); return; }
    const kb = getKeybindings();
    const history = kb.matches(data, "tui.editor.historyPrevious") || kb.matches(data, "tui.editor.historyNext");
    if (this.actions.models && !history) {
      if (kb.matches(data, "app.model.select")) { void this.changeModel(); return; }
      if (kb.matches(data, "app.model.cycleForward")) { void this.changeModel("cycle"); return; }
      if (kb.matches(data, "app.model.cycleBackward")) { void this.changeModel("cycle", true); return; }
      if (kb.matches(data, "app.thinking.cycle")) { void this.changeModel("", false, true); return; }
    }
    if (matchesKey(data, Key.left) && !this.editor.getText()) return this.actions.back();
    if (this.panel?.focused) { this.panel.handleInput(data); return; }
    if (matchesKey(data, Key.down) && this.panel?.hasRows && this.atPromptEnd()) { this.panel.enter(this.editor); return; }
    if (getKeybindings().matches(data, "app.editor.external")) { void this.openExternalEditor(); return; }
    if (getKeybindings().matches(data, "app.clipboard.pasteImage")) { void this.pasteClipboard(); return; }
    if (this.editor.isShowingAutocomplete()) { this.editor.handleInput(data); return; }
    if (matchesKey(data, Key.escape)) {
      if (this.transcript.status?.running !== false || this.inFlight > 0) {
        this.lastEscapeTime = 0;
        void this.actions.stop().catch(error => { this.transcript.note = String(error); this.transcript.changed(); });
      } else if (!this.editor.getText().trim() && this.actions.doubleEscapeAction !== "none") {
        const now = Date.now();
        if (now - this.lastEscapeTime < 500) {
          this.lastEscapeTime = 0;
          if (this.actions.doubleEscapeAction === "fork") { if (this.actions.fork) void this.showForkPicker(); }
          else if (this.actions.tree) void this.showTreePicker();
        }
        else this.lastEscapeTime = now;
      }
      return;
    }
    // Pi's alt+up: queued messages leave the queue and join the draft; Enter sends them again, clearing drops them.
    if (this.actions.dequeue && getKeybindings().matches(data, "app.message.dequeue")) {
      this.run("Restoring queued messages…", this.actions.dequeue(), ({ texts }) => {
        if (!texts.length) return "No queued messages to restore";
        this.editor.setText([...texts, this.editor.getText()].filter(text => text.trim()).join("\n\n"));
        return `Restored ${texts.length} queued message${texts.length > 1 ? "s" : ""} to editor`;
      });
      return;
    }
    // Pi's follow-up key (option+enter on a Mac, or the user's own binding in Pi's keybindings.json).
    if (getKeybindings().matches(data, "app.message.followUp")) return this.submit(this.editor.getExpandedText(), "followUp");
    if (this.transcript.toggle(data)) return;
    this.editor.handleInput(data);
  }
  invalidate() { this.transcript.invalidate(); this.editor.invalidate(); }
  dispose() { this.disposed = true; this.picker?.dispose?.(); this.transcript.dispose(); this.panel?.dispose(); }
}
