// Terminal presentation only. Nothing here changes delivery, acknowledgement or worker execution.
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { promptAutocomplete } from "./autocomplete.ts";
import { agentDir } from "./paths.ts";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { piClipboard } from "./presentation.ts";
import { homedir } from "node:os";

import { getMarkdownTheme, getSelectListTheme, keyText, ToolExecutionComponent, UserMessageSelectorComponent, type Theme, type ThemeBg } from "@earendil-works/pi-coding-agent";
import { builtInRenderers, loadToolRenderers, piExternalEditor, piModelSelector, piThinkingSelector, piTreeSelector } from "./presentation.ts";
import {
  Box, Editor, getKeybindings, Loader, ScrollView, VStack, Key, Markdown, matchesKey, MouseRegion, Text, truncateToWidth, visibleWidth,
  type Component, type DefaultTextStyle, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { clean, firstLine, textOf, liveStatus, formatUsage, statusWord, formatDuration, formatAgo, formatTokens, formatContext, formatCost, type WorkerStatus } from "./status.ts";
import type { TreeResult } from "./source.ts";
import type { ChatItem, Queued } from "./chat.ts";
import type { ModelChoice } from "./model-choices.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { nextModel, modelThinking, modelNotice, thinkingSelection } from "./model-selection.ts";
import type { Action, Delivery, Mode } from "./protocol.ts";

export type ViewResult = { type: "back" } | { type: "send"; mode: Mode } | { type: "stop" };

const COLLAPSED_LINES = 4;
// Same small formatter as Pi's footer (not exported by its public package index).
const formatCwd = (cwd: string) => {
  const home = homedir();
  return cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
};
const expandKey = () => { try { return keyText("app.tools.expand") || "ctrl+o"; } catch { return "ctrl+o"; } };


export const glyph = (w: WorkerStatus) => !w.enabled ? "■" : w.running ? "●" : "○";
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const VISIBLE_RUNNING = 5;
/** Idle workers keep their row this long after their last reply, then join the summary count. */
const RECENT_MS = 60_000;
const recent = (w: WorkerStatus, now: number) => w.enabled && !w.running && !!w.finishedAt && now - w.finishedAt < RECENT_MS;
const VISIBLE_FOCUSED = 8;

export function statusRow(w: WorkerStatus, width: number, selected: boolean, now: number, theme: Theme, nameWidth: number, frame = 0, idleText?: string, modelMinWidth = 80) {
  const t = theme;
  const mark = !w.enabled ? t.fg("muted", "■") : w.running ? t.fg("accent", SPINNER[frame % SPINNER.length]!) : t.fg("muted", "○");
  const name = truncateToWidth(clean(w.name), nameWidth, "…", true);
  const left = `${selected ? t.fg("accent", "› ") : "  "}${mark} ${selected ? t.fg("accent", t.bold(name)) : w.running ? name : t.fg("muted", name)}  `;
  const time = w.running && w.since ? formatDuration(now - w.since)
    : !w.running && w.since && w.finishedAt && w.finishedAt >= w.since ? formatDuration(w.finishedAt - w.since) : "";
  // On narrow terminals the model drops first, then the cost, then the activity text.
  const model = width >= modelMinWidth && w.model ? `${w.model}${w.thinking ? ` ${w.thinking}` : ""}` : "";
  const right = [model, time, formatContext(w), width >= 70 && formatCost(w.cost)].filter(Boolean).join(" · ");
  const showRight = width >= 40 && right;
  const middle = !w.enabled ? "stopped" : w.running ? w.activity ?? "running"
    : idleText ?? `idle${w.finishedAt ? ` · last reply ${formatAgo(now - w.finishedAt)}` : ""}`;
  const space = width - visibleWidth(left) - (showRight ? visibleWidth(right) + 2 : 0);
  const mid = width >= 60 && space > 4 ? truncateToWidth(w.running ? middle : t.fg("dim", middle), space, "…", true) : " ".repeat(Math.max(0, space));
  return truncateToWidth(`${left}${mid}${showRight ? `  ${t.fg("dim", right)}` : ""}`, width);
}

/**
 * Team panel under the prompt. Collapsed, it lists running workers (one per line, animated) and
 * summarizes the rest. Down from an empty prompt focuses it: every worker is listed and selectable.
 * Up past the first row, Esc, or typing returns to the prompt.
 */
export class TeamPanel implements Component, Focusable {
  focused = false;
  private workers: WorkerStatus[] = [];
  private selected = 0;
  private frame = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;
  private rows: (WorkerStatus | undefined)[] = [];
  private returnTo?: Component;
  private focus: (component: Component) => void;
  private compact: boolean;
  private tui: TUI; private theme: Theme; private onOpen: (worker: WorkerStatus) => void;
  constructor(tui: TUI, theme: Theme, onOpen: (worker: WorkerStatus) => void, options: { compact?: boolean; focus?: (component: Component) => void } = {}) { this.tui = tui; this.theme = theme; this.onOpen = onOpen; this.compact = options.compact ?? false; this.focus = options.focus ?? (component => tui.setFocus(component)); }

  get hasWorkers() { return this.workers.length > 0; }
  /** Focused component, so the caller can check the main prompt has focus. Not on Pi's public TUI type. */
  currentFocus() { return (this.tui as { getFocusedComponent?: () => unknown }).getFocusedComponent?.(); }
  setWorkers(workers: WorkerStatus[]) {
    const keep = this.workers[this.selected]?.id;
    const rank = (w: WorkerStatus) => !w.enabled ? 2 : w.running ? 0 : 1;
    this.workers = [...workers].sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 0 ? (a.since ?? 0) - (b.since ?? 0) : (b.finishedAt ?? 0) - (a.finishedAt ?? 0)));
    const index = this.workers.findIndex(w => w.id === keep);
    this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, this.workers.length - 1));
    if (!this.workers.length && this.focused) this.leave();
    // Animate only running workers; recent idle rows need just one expiry render.
    clearTimeout(this.expiry);
    const now = Date.now();
    const expires = this.workers.filter(w => recent(w, now)).map(w => w.finishedAt! + RECENT_MS - now);
    if (expires.length && !this.compact) this.expiry = setTimeout(() => this.setWorkers(this.workers), Math.min(...expires));
    const running = this.workers.some(w => w.running);
    if (running && !this.ticker) this.ticker = setInterval(() => { this.frame++; this.tui.requestRender(); }, 100);
    if (!running && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    this.tui.requestRender();
  }
  enter(editor: Component, target?: string) { this.returnTo = editor; this.selected = Math.max(0, this.workers.findIndex(w => w.id === target)); this.focus(this); this.tui.requestRender(); }
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
    this.rows = [];
    if (!this.workers.length) return [];
    const lines: string[] = [];
    const push = (line: string, worker?: WorkerStatus) => { lines.push(line); this.rows.push(worker); };
    if (this.focused) {
      // Leave room for the conversation and prompt on short terminals.
      const visible = Math.max(1, Math.min(VISIBLE_FOCUSED, (this.tui.terminal?.rows ?? 24) - 12));
      const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), this.workers.length - visible));
      for (const [i, w] of this.workers.slice(start, start + visible).entries()) push(statusRow(w, width, start + i === this.selected, now, t, nameWidth, this.frame), w);
      const more = this.compact || this.workers.length > visible ? `${this.selected + 1}/${this.workers.length} · ` : "";
      push(truncateToWidth(t.fg("dim", `  ${more}↑↓ select · enter open · esc back`), width));
      return lines;
    }
    const running = this.workers.filter(w => w.running);
    const shown = this.compact ? running : [...running, ...this.workers.filter(w => recent(w, now))];
    for (const w of this.compact ? shown : shown.slice(0, VISIBLE_RUNNING)) push(statusRow(w, width, false, now, t, nameWidth, this.frame), w);
    if (this.ticker && !shown.length) { clearInterval(this.ticker); this.ticker = undefined; } // last recent row expired
    const idle = this.workers.filter(w => w.enabled && !w.running && !shown.includes(w)).length;
    const stopped = this.workers.filter(w => !w.enabled).length;
    // Every worker's cost, listed or not; "(sub)" as in Pi's footer when any of it is subscription-billed.
    const total = formatCost(this.workers.reduce((sum, w) => sum + (w.cost ?? 0), 0));
    if (this.compact) {
      push(truncateToWidth(t.fg("dim", `  ${idle} idle · ${stopped} stopped · team ${total || "$0.000"}${this.workers.some(w => w.subscription) ? " (sub)" : ""} · ↓ to select`), width));
      return lines;
    }
    const summary = [shown.length > VISIBLE_RUNNING && `+${shown.length - VISIBLE_RUNNING} more`,
      idle && `${idle} idle`, stopped && `${stopped} stopped`,
      total && `team ${total}${this.workers.some(w => w.subscription) ? " (sub)" : ""}`].filter(Boolean).join(" · ");
    push(truncateToWidth(t.fg("dim", `  ${shown.length || total ? "" : "team · "}${summary ? `${summary} · ` : ""}↓ to select`), width));
    return lines;
  }
  handleInput(data: string) {
    if (matchesKey(data, Key.up)) { if (this.selected === 0) return this.leave(); this.selected--; }
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.workers.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter)) { const w = this.workers[this.selected]; if (w) this.onOpen(w); return; }
    else if (matchesKey(data, Key.escape)) return this.leave();
    else return this.leave(data);
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const worker = this.rows[event.y];
    if (!worker) return undefined;
    this.selected = Math.max(0, this.workers.indexOf(worker));
    this.onOpen(worker);
    return { handled: true };
  }
  invalidate() {}
  dispose() { if (this.ticker) clearInterval(this.ticker); this.ticker = undefined; clearTimeout(this.expiry); }
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
  const body = new Markdown(clean(valid ? d!.text : raw), 0, 0, getMarkdownTheme(), { color: text => theme.fg("customMessageText", text) });
  if (!expanded) {
    box.addChild(new Clamp(body, COLLAPSED_LINES, hidden => theme.fg("dim", `… ${hidden} more lines · click or ${expandKey()} to expand`)));
    return box;
  }
  box.addChild(body);
  if (valid) box.addChild(new Text(theme.fg("dim", `\nfrom ${clean(d!.from.id)} · delivery ${clean(d!.id)}${d!.request ? ` · request ${clean(d!.request)}` : ""}`), 0, 0));
  return box;
}

/** A message the human sent directly from the Team view. Display only; not model context. */
export function renderSent(data: { target: string; mode: Mode; text: string; request?: string } | undefined, expanded: boolean, theme: Theme): Component {
  return new ClickToExpand(expanded, value => sentNote(data, value, theme));
}
function sentNote(data: { target: string; mode: Mode; text: string; request?: string } | undefined, expanded: boolean, theme: Theme) {
  const header = theme.fg("muted", `You → ${clean(data?.target)} · ${data?.mode === "steer" ? "steer" : "follow-up"} · accepted${data?.request ? ` · request ${data.request}` : ""}`);
  const body = new Text(theme.fg("dim", clean(data?.text)), 2, 0);
  const box = new Box(1, 0); box.addChild(new Text(header, 0, 0));
  box.addChild(expanded ? body : new Clamp(body, 2, hidden => theme.fg("dim", `  … ${hidden} more lines`)));
  return box;
}

export function renderTeamCall(args: Partial<Action>, theme: Theme) {
  const subject = args.action === "spawn" ? args.name : args.target ?? (args.action === "stop" && args.team ? "whole team" : "");
  let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", args.action ?? "") + (subject ? ` ${clean(subject)}` : "");
  const extras = [args.mode === "steer" && "steer", args.scope === "mains" && "sessions", args.transcript && "transcript", args.request && `request ${args.request}`].filter(Boolean);
  if (extras.length) text += theme.fg("muted", ` · ${extras.join(" · ")}`);
  if (args.message) text += `\n${theme.fg("muted", truncateToWidth(firstLine(args.message), 160))}`;
  return new Text(text, 0, 0);
}

/** One-line receipts; the raw JSON stays available on expansion. */
export function teamResultSummary(args: Partial<Action>, details: any): string {
  if (args.action === "list") {
    if (!Array.isArray(details)) return "";
    return details.filter(a => args.scope === "mains" || a.role === "worker").map(a => a.role === "main"
      ? `${clean(a.name)} · ${a.connected ? "connected" : "offline"}`
      : `${a.enabled === false ? "■" : "○"} ${clean(a.name)}${a.enabled === false ? " · stopped" : ""}`).join("\n") || "no workers";
  }
  if (args.action === "spawn" || args.action === "send") {
    if (details?.taskId !== undefined) return `accepted · request ${details.taskId} · report arrives automatically`;
    if (details?.delivery) return "accepted · queued for that session";
    return "accepted";
  }
  if (args.action === "stop") return `stopped ${details?.stopped?.length ?? 0} worker(s)${details?.paused ? " · team paused" : ""}`;
  if (args.action === "inspect") {
    if (args.request) {
      const state = details?.state;
      const status = state?.status === "terminal" ? state.outcome?.status : state?.status;
      const answer = firstLine(textOf(details?.answer));
      return `request ${details?.request} · ${status ?? "unknown"}${answer ? `\n${answer}` : ""}`;
    }
    if (args.transcript) return `${details?.entries?.length ?? 0} entries${details?.next ? " · older pages available" : ""}`;
    const latest = firstLine(details?.role === "main" ? details?.latest : textOf(details?.latest));
    const head = details?.role === "main" ? "latest publication · may be stale" : statusWord(liveStatus(details ?? {}));
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

export type TranscriptOptions = { showThinking?: boolean; expanded?: boolean; tui?: TUI; cwd?: string };

/** Worker transcript as terminal lines, oldest first, drawn like Pi's chat: inputs on Pi's message
 * backgrounds, tool calls by Pi's own tool component and renderers, replies plain. */
export function renderTranscript(items: ChatItem[], worker: string, width: number, theme: Theme, { showThinking = false, expanded = false, tui, cwd = process.cwd() }: TranscriptOptions = {}): string[] {
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
          const tool = new ToolExecutionComponent(part.name, part.id, args, { showImages: false }, renderers as any, ui, cwd);
          tool.setExpanded(expanded);
          const result = results.get(part.id);
          if (result) tool.updateResult({ content: result.content ?? (result.error ? [{ type: "text", text: result.error }] : []),
            details: result.details, isError: !result.ok, ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }) });
          out.push(...tool.render(width)); // starts with its own blank line
        }
      }
      if (item.error) block(new Text(theme.fg("error", item.error), 1, 0).render(width));
      if (item.turn) {
        const parts = [item.at !== undefined && clock(item.at), item.turn.ms !== undefined && formatDuration(item.turn.ms), item.turn.tokens && `${formatTokens(item.turn.tokens)} tok`, formatCost(item.turn.cost)];
        block(new Text(theme.fg("dim", parts.filter(Boolean).join(" · ")), 1, 0).render(width));
      }
    } else if (item.kind === "notice") block(new Text(theme.fg(item.warning ? "warning" : "dim", item.text), 1, 0).render(width));
  }
  return out[0] === "" ? out.slice(1) : out;
}

export type WorkerSource = {
  page(cursor?: string): Promise<{ conversationId?: string; items: ChatItem[]; queued?: Queued[]; next?: string }>;
  status(): Promise<WorkerStatus>;
  watch(signal: AbortSignal, onFrame: () => void): Promise<void>;
};

export type ChatActions = {
  send(text: string, mode: Mode, images?: import("@earendil-works/pi-ai").ImageContent[]): Promise<unknown>; stop(): Promise<unknown>; back(): void;
  /** `/compact [instructions]` in the editor. */
  models?(): Promise<ModelChoice[]>;
  setModel?(model: ModelChoice, thinking: ModelThinkingLevel): Promise<unknown>;
  compact?(instructions: string): Promise<{ outcome: "compacted" | "nothing" | "running" | "failed"; error?: string }>;
  /** `/fork` and `/clone`, top-level agents only: the human's messages, and a fork before one of them or of everything. */
  inputs?(): Promise<{ id: string; text: string }[]>;
  fork?(before?: string, draft?: string): Promise<unknown>;
  tree?(entryId?: string): Promise<TreeResult>;
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
  showThinking = false;
  expanded = false; // Pi's ctrl+o: full tool output
  queued: Queued[] = [];
  /** What the human just started and the host has not finished, shown at once like Pi's status spinner. */
  pending?: string;
  /** Pi's pending-message lines above the editor: messages waiting for the agent's next boundary. */
  queuedLines(width: number) {
    if (!this.queued.length) return [];
    return ["", ...this.queued.map(q => truncateToWidth(` ${this.theme.fg("dim", `${q.mode === "steer" ? "Steering" : "Follow-up"}: ${q.text}`)}`, width))];
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
          if (page.conversationId !== this.conversationId) {
            this.entries.clear(); this.olderLoaded = false; this.next = undefined; this.offset = 0;
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
  async older() {
    if (!this.next) { this.note = "start of transcript"; this.changed(); return; }
    try {
      const page = await this.source.page(this.next);
      if (this.life.signal.aborted) return;
      for (const entry of page.items) this.entries.set(String(entry.id), entry);
      this.next = page.next; this.olderLoaded = true; this.prepended = true; this.version++;
    } catch (error) { this.note = String(error); }
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
  lines(width: number) {
    if (this.cache?.width !== width || this.cache.version !== this.version) {
      this.cache = { width, version: this.version, lines: renderTranscript([...this.entries.values()], this.name, width, this.theme, { showThinking: this.showThinking, expanded: this.expanded, tui: this.tui, cwd: this.status?.cwd }) };
    }
    const lines = this.cache.lines;
    // Keep a scrolled-up view anchored when activity is appended; prepending older pages needs no shift.
    if (this.lastLength?.width === width && lines.length !== this.lastLength.length && !this.prepended && this.offset > 0) {
      this.offset += lines.length - this.lastLength.length;
      if (lines.length > this.lastLength.length) this.unseen = true;
    }
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
        s.enabled && s.finishedAt && `idle ${formatDuration(now - s.finishedAt)}`].filter(Boolean).join(" · ");
    const cwd = s.cwd ? formatCwd(s.cwd) : "";
    return [s.model && `${s.model}${s.thinking ? ` ${s.thinking}` : ""}`, time, formatContext(s), formatCost(s.cost), cwd].filter(Boolean).join(" · ");
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
    const color = !status ? "muted" : !status.enabled ? "warning" : status.running ? "accent" : "muted";
    const connection = this.transcript.connection === "live" ? t.fg("success", "live") : this.transcript.connection === "stale" ? t.fg("warning", "stale · r to refresh") : t.fg("muted", "loading");
    const top = this.transcript.next ? t.fg("dim", " · older pages: o") : "";
    const header = `${t.fg("accent", t.bold(this.transcript.name))}${t.fg("dim", " · ")}${t.fg(color, word)}${t.fg("dim", " · ")}${connection}${top}`;
    const rule = t.fg("borderMuted", "─".repeat(Math.max(0, width)));
    const hints = [this.transcript.unseen && t.fg("accent", "↓ new activity · end"), this.transcript.note && t.fg("warning", this.transcript.note),
      t.fg("dim", `esc back · f follow-up · s steer · x stop · ↑↓ pgup/pgdn scroll · o older · t thinking · ${keyText("app.tools.expand")} expand · r refresh`)].filter(Boolean).join(t.fg("dim", " · "));
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
    if (data === "x") return this.done({ type: "stop" });
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
  readonly layout: VStack;
  constructor(tui: TUI, theme: Theme, name: string, source: WorkerSource, parent: AbortSignal, actions: ChatActions, notice: () => string = () => "", children?: { open(worker: WorkerStatus): void }, branch: () => string = () => "") {
    this.actions = actions;
    this.tui = tui;
    this.transcript = new Transcript(tui, theme, name, source, parent, true);
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.setAutocompleteProvider(promptAutocomplete(() => this.transcript.status?.cwd ?? homedir()));
    this.editor.onSubmit = text => this.submit(text, "steer");
    if (children) this.panel = new TeamPanel(tui, theme, children.open, { compact: true, focus: component => {
      this.panel!.focused = component === this.panel;
      this.editor.focused = component !== this.panel;
    } });
    const scroll = new ScrollView(this.transcript, { follow: "end", primary: true });
    const footer = { render: (width: number) => {
      const s = this.transcript.status;
      const cwd = s?.cwd ? formatCwd(s.cwd) : "";
      const time = s?.running ? `working${s.since ? ` ${formatDuration(Date.now() - s.since)}` : ""}` : s && !s.enabled ? "stopped" : "idle";
      const suffix = `${branch() ? ` (${branch()})` : ""} • ${s?.name ?? name} · ${time}`;
      const location = truncateToWidth(cwd, Math.max(0, width - visibleWidth(suffix))) + suffix;
      const stats = formatUsage(s);
      const model = s?.modelId ?? s?.model;
      const right = model ? `${s?.provider ? `(${s.provider}) ` : ""}${model}${s?.thinking ? ` • ${s.thinking}` : ""}` : "";
      // Keep a useful stats prefix; omit the model rather than showing a fragment of its ID.
      const room = width - visibleWidth(right) - 2;
      const left = truncateToWidth(stats, right && room >= 24 ? room : width);
      const statsLine = right && room >= 24 ? left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right : left;
      const hints = `${s?.name ?? name} · ${s?.id ?? "…"} · ← back · esc stop · ${keyText("app.message.followUp")} follow-up · ${keyText("app.tools.expand")} ${this.transcript.expanded ? "collapse" : "expand"} · ${keyText("app.thinking.toggle")} thinking`;
      return [location, statsLine, [hints, this.transcript.note, notice()].filter(Boolean).join(" · ")].map(line => truncateToWidth(theme.fg("dim", line), width));
    }, invalidate() {} };
    const working = { render: (width: number) => [...this.transcript.queuedLines(width), ...this.transcript.workingLine(width), ...(this.modelNote ? [truncateToWidth(theme.fg("muted", this.modelNote), width)] : [])], invalidate() {} };
    // Pi's selectors take the editor's place while open.
    const input = { render: (width: number) => (this.picker?.component ?? this.editor).render(width), invalidate: () => this.editor.invalidate() };
    this.layout = new VStack([{ component: scroll, grow: 1, basis: 0 }, working, input, ...(this.panel ? [this.panel] : []), footer]);
  }
  /** Text for the editor, as Pi restores a forked message. */
  setDraft(text: string) { this.editor.setText(text); }
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
    if (this.actions.fork && (command === "/fork" || command === "/clone")) {
      this.editor.setText("");
      if (command === "/clone") this.run("Cloning…", this.actions.fork(), () => undefined);
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
    if (matchesKey(data, Key.down) && !this.editor.getText() && this.panel?.hasWorkers) { this.panel.enter(this.editor); return; }
    if (getKeybindings().matches(data, "app.editor.external")) { void this.openExternalEditor(); return; }
    if (getKeybindings().matches(data, "app.clipboard.pasteImage")) { void this.pasteClipboard(); return; }
    if (this.editor.isShowingAutocomplete()) { this.editor.handleInput(data); return; }
    if (matchesKey(data, Key.escape)) {
      if (this.transcript.status?.running !== false || this.inFlight > 0 || this.editor.getText().trim()) {
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
    // Pi's follow-up key (option+enter on a Mac, or the user's own binding in Pi's keybindings.json).
    if (getKeybindings().matches(data, "app.message.followUp")) return this.submit(this.editor.getExpandedText(), "followUp");
    if (this.transcript.toggle(data)) return;
    this.editor.handleInput(data);
  }
  invalidate() { this.transcript.invalidate(); this.editor.invalidate(); }
  dispose() { this.disposed = true; this.picker?.dispose?.(); this.transcript.dispose(); this.panel?.dispose(); }
}
