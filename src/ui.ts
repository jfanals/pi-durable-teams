// Terminal presentation only. Nothing here changes delivery, acknowledgement or worker execution.
import { homedir } from "node:os";

import { getMarkdownTheme, getSelectListTheme, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box, Editor, ScrollView, VStack, Key, Markdown, matchesKey, MouseRegion, stripTerminalSequences, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { Action, Delivery, Mode } from "./protocol.ts";

export type WorkerStatus = {
  id: string; name: string; enabled: boolean; running?: boolean;
  /** Plain-words current activity while running: "reading src/ui.ts", "thinking", … */
  activity?: string;
  /** Start of the current or last request; end of the last answer. */
  since?: number; finishedAt?: number;
  /** List-price cost so far; subscription when its provider bills by subscription, not by this price. */
  cost?: number; subscription?: boolean;
  /** Short model label and thinking level, e.g. "opus-5-5" and "medium". */
  model?: string; thinking?: string;
  /** Prompt size of the latest reply and the model's window; working directory. */
  context?: number; contextWindow?: number; cwd?: string;
};
export type TranscriptEntry = { id: number | string; kind: string; model?: any[]; data?: any };
export type ViewResult = { type: "back" } | { type: "send"; mode: Mode } | { type: "stop" };

const COLLAPSED_LINES = 4;
const clean = (text: unknown) => stripTerminalSequences(String(text ?? ""));
const firstLine = (text: unknown) => clean(text).split("\n").find(line => line.trim())?.trim() ?? "";
const expandKey = () => { try { return keyText("app.tools.expand") || "ctrl+o"; } catch { return "ctrl+o"; } };
const textOf = (message: any) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).flatMap((part: any) => part.type === "text" ? [part.text] : []).join("\n");

export const glyph = (w: WorkerStatus) => !w.enabled ? "■" : w.running ? "●" : "○";
export const statusWord = (w: WorkerStatus) => !w.enabled ? "stopped" : w.running ? (w.activity ?? "running") : "idle";

const VERBS: Record<string, string> = { read: "reading", edit: "editing", write: "writing", bash: "bash:" };
/** What a running worker is doing, from its committed live state. Never infers success. */
function describe(live: any, latest: any): string {
  const slot = live?.tools?.find((s: any) => s.status === "running") ?? live?.tools?.find((s: any) => s.status === "pending");
  if (slot) {
    const call = latest?.content?.find((part: any) => part.type === "toolCall" && part.id === slot.callId);
    const args = call?.arguments ?? {};
    const subject = firstLine(args.path ?? args.command ?? args.target ?? args.name ?? "");
    return `${VERBS[slot.name] ?? clean(slot.name)}${subject ? ` ${subject}` : ""}`;
  }
  if (live?.compactions?.length) return "compacting context";
  if (live?.generation?.retry) return `retrying · ${firstLine(live.generation.retry.error)}`;
  const parts = live?.generation?.message?.content ?? [];
  if (parts.some((part: any) => part.type === "toolCall")) return "choosing a tool";
  if (parts.some((part: any) => part.type === "text" && part.text)) return "writing";
  return "thinking";
}
const costOf = (usage: any) => {
  const buckets = Object.values(usage?.models ?? {}) as any[];
  return buckets.length ? buckets.reduce((sum, u) => sum + (u?.cost?.total ?? 0), 0) : undefined;
};
/** Model ID without provider or "claude-" prefix: "claude-opus-5-5" → "opus-5-5". */
const shortModel = (id: unknown) => typeof id === "string" && id ? clean(id).split("/").pop()!.replace(/^claude-/, "") : undefined;
/** Tokens a request processed, for transcript stamps: everything except cache reads. */
const replyTokens = (u: any) => (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0);
export function liveStatus(worker: { id: string; name: string; enabled?: boolean; agent?: any; live?: any; usage?: any; latest?: any; since?: unknown; contextWindow?: unknown; subscription?: unknown }): WorkerStatus {
  const running = Boolean(worker.live?.run);
  const thinking = worker.agent?.thinkingLevel ?? worker.latest?.providerThinkingLevel;
  return {
    id: worker.id, name: worker.name, enabled: worker.enabled !== false, running,
    activity: running ? describe(worker.live, worker.latest) : undefined,
    since: typeof worker.since === "number" ? worker.since : undefined,
    finishedAt: typeof worker.latest?.timestamp === "number" ? worker.latest.timestamp : undefined,
    cost: costOf(worker.usage), subscription: worker.subscription === true,
    model: shortModel(worker.agent?.model?.modelId ?? worker.latest?.model ?? Object.keys(worker.usage?.models ?? {})[0]),
    thinking: typeof thinking === "string" && thinking !== "off" ? clean(thinking) : undefined,
    context: worker.latest?.usage ? replyTokens(worker.latest.usage) + (worker.latest.usage.cacheRead ?? 0) : undefined,
    contextWindow: typeof worker.contextWindow === "number" && worker.contextWindow > 0 ? worker.contextWindow : undefined,
    cwd: typeof worker.agent?.cwd === "string" ? clean(worker.agent.cwd) : undefined,
  };
}
export const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
};
const formatAgo = (ms: number) => ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : `${Math.floor(ms / 3_600_000)}h ago`;
// Pi footer formats: tokens "950", "4.2k", "188k", "1.0M"; context "18.8%/1M"; cost "$9.812".
export const formatTokens = (n: number) => n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k`
  : n < 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1_000_000)}M`;
export const formatContext = (w: WorkerStatus) => w.context === undefined ? ""
  : w.contextWindow ? `${(100 * w.context / w.contextWindow).toFixed(1)}%/${formatTokens(w.contextWindow)}` : `${formatTokens(w.context)} ctx`;
export const formatCost = (cost?: number) => cost ? `$${cost.toFixed(3)}` : "";

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
  private rows: (WorkerStatus | undefined)[] = [];
  private returnTo?: Component;
  private tui: TUI; private theme: Theme; private onOpen: (worker: WorkerStatus) => void;
  constructor(tui: TUI, theme: Theme, onOpen: (worker: WorkerStatus) => void) { this.tui = tui; this.theme = theme; this.onOpen = onOpen; }

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
    // Tick while something animates or a recent row still has to expire.
    const running = this.workers.some(w => w.running || recent(w, Date.now()));
    if (running && !this.ticker) this.ticker = setInterval(() => { this.frame++; this.tui.requestRender(); }, 100);
    if (!running && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    this.tui.requestRender();
  }
  enter(editor: Component) { this.returnTo = editor; this.selected = 0; this.tui.setFocus(this); this.tui.requestRender(); }
  private leave(forward?: string) {
    const editor = this.returnTo;
    if (!editor) return;
    this.tui.setFocus(editor);
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
      const more = this.workers.length > visible ? `${this.selected + 1}/${this.workers.length} · ` : "";
      push(truncateToWidth(t.fg("dim", `  ${more}↑↓ select · enter open · esc back`), width));
      return lines;
    }
    const running = this.workers.filter(w => w.running);
    const shown = [...running, ...this.workers.filter(w => recent(w, now))];
    for (const w of shown.slice(0, VISIBLE_RUNNING)) push(statusRow(w, width, false, now, t, nameWidth, this.frame), w);
    if (this.ticker && !shown.length) { clearInterval(this.ticker); this.ticker = undefined; } // last recent row expired
    const idle = this.workers.filter(w => w.enabled && !w.running && !shown.includes(w)).length;
    const stopped = this.workers.filter(w => !w.enabled).length;
    // Every worker's cost, listed or not; "(sub)" as in Pi's footer when any of it is subscription-billed.
    const total = formatCost(this.workers.reduce((sum, w) => sum + (w.cost ?? 0), 0));
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
  dispose() { if (this.ticker) clearInterval(this.ticker); this.ticker = undefined; }
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

/** Worker transcript as terminal lines, oldest first. Tool calls are paired with their results by call ID. */
export function renderTranscript(entries: TranscriptEntry[], worker: string, width: number, theme: Theme, showThinking = false): string[] {
  const results = new Map<string, any>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.tool-result" && message?.toolCallId) results.set(message.toolCallId, message);
  }
  const md = getMarkdownTheme();
  const out: string[] = [];
  let speaker: string | undefined; // consecutive turns by the same speaker share one heading
  const block = (lines: string[], who?: string) => {
    if (who && who === speaker) { out.push(...lines.slice(1)); return; }
    if (out.length) out.push("");
    out.push(...lines); speaker = who;
  };
  const markdown = (text: string, color?: (t: string) => string) => new Markdown(clean(text), 0, 0, md, color ? { color } : undefined).render(width);
  const wrap = (text: string) => wrapTextWithAnsi(text, width);
  const sorted = [...entries].sort((a, b) => Number(a.id) - Number(b.id));
  // One dim stamp per answered request: clock time, wall time since its input, tokens and cost of all its model calls.
  let turnStart: number | undefined; let turnTokens = 0; let turnCost = 0;
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  for (const entry of sorted) {
    const message = entry.model?.[0];
    switch (entry.kind) {
      case "teams.message":
      case "teams.report":
      case "pi.user": {
        if (typeof message?.timestamp === "number" && turnStart === undefined) { turnStart = message.timestamp; turnTokens = 0; turnCost = 0; }
        const from = entry.data?.from?.name ?? "input";
        const text = entry.kind === "teams.message" ? entry.data?.message ?? textOf(message) : textOf(message);
        block([...wrap(theme.fg("accent", theme.bold(`${clean(from)} → ${worker}`)) + (entry.kind === "teams.report" ? theme.fg("dim", " · report") : "")), ...markdown(text)]);
        break;
      }
      case "pi.assistant": {
        const lines: string[] = [];
        for (const part of message?.content ?? []) {
          if (part.type === "text" && part.text.trim()) lines.push(...markdown(part.text));
          else if (part.type === "thinking" && part.thinking?.trim()) {
            lines.push(...(showThinking ? markdown(part.thinking, t => theme.fg("thinkingText", t)) : wrap(theme.fg("dim", `▸ thinking · ${part.thinking.split("\n").length} lines`))));
          } else if (part.type === "toolCall") {
            const args = part.arguments ?? {};
            const subject = args.path ?? args.command ?? args.target ?? Object.values(args).find(v => typeof v === "string") ?? "";
            const result = results.get(part.id);
            const outcome = !result ? theme.fg("dim", " · no result")
              : result.isError ? theme.fg("error", ` ✗ ${firstLine(textOf(result).replace(/<\/?harness>/g, "").replace(/^\[error\]\s*/m, ""))}`)
              : theme.fg("success", " ✓");
            lines.push(truncateToWidth(theme.fg("muted", `▸ ${clean(part.name)} `) + clean(firstLine(subject)) + outcome, width));
          }
        }
        if (message?.stopReason === "error" || message?.stopReason === "aborted") {
          lines.push(...wrap(theme.fg("error", `${message.stopReason}${message.errorMessage ? `: ${clean(message.errorMessage)}` : ""}`)));
        }
        turnTokens += replyTokens(message?.usage); turnCost += message?.usage?.cost?.total ?? 0;
        if (message?.stopReason && message.stopReason !== "toolUse" && typeof message.timestamp === "number") {
          const parts = [clock(message.timestamp), turnStart !== undefined && message.timestamp >= turnStart && formatDuration(message.timestamp - turnStart),
            turnTokens && `${formatTokens(turnTokens)} tok`, formatCost(turnCost)];
          lines.push(theme.fg("dim", parts.filter(Boolean).join(" · ")));
          turnStart = undefined; turnTokens = 0; turnCost = 0;
        }
        if (lines.length) block([theme.fg("customMessageLabel", theme.bold(worker)), ...lines], worker);
        break;
      }
      case "pi.tool-result": case "pi.system": break;
      case "pi.compaction": block(wrap(theme.fg("dim", "— context compacted —"))); break;
      case "pi.reset": block(wrap(theme.fg("dim", "— context reset —"))); break;
      default: block(wrap(theme.fg("dim", `[${clean(entry.kind)}]`)));
    }
  }
  return out;
}

export type WorkerSource = {
  page(cursor?: string): Promise<{ entries: TranscriptEntry[]; next?: string }>;
  status(): Promise<WorkerStatus>;
  watch(signal: AbortSignal, onFrame: () => void): Promise<void>;
};

export type ChatActions = {
  send(text: string, mode: Mode): Promise<unknown>; stop(): Promise<unknown>; back(): void;
};

/** Shared committed transcript, loading, watch and paging for both shells. */
class Transcript implements Component {
  entries = new Map<string, TranscriptEntry>();
  next?: string;
  private olderLoaded = false;
  status?: WorkerStatus;
  connection: "loading" | "live" | "stale" = "loading";
  note?: string;
  offset = 0; // lines scrolled up from the bottom; 0 follows live activity
  unseen = false;
  showThinking = false;
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
  private clockTimer?: ReturnType<typeof setInterval>; // ticks the "working" time while the worker runs

  tui: TUI; theme: Theme; name: string; source: WorkerSource;
  constructor(tui: TUI, theme: Theme, name: string, source: WorkerSource, parent: AbortSignal) {
    this.tui = tui; this.theme = theme; this.name = name; this.source = source;
    this.parent = parent;
    parent.addEventListener("abort", this.onParentAbort, { once: true });
    void this.refresh().then(() => this.attach());
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
          for (const entry of page.entries) this.entries.set(String(entry.id), entry);
          if (!this.olderLoaded) this.next = page.next;
          this.status = status; this.note = undefined; this.version++;
          if (status.running && !this.clockTimer) this.clockTimer = setInterval(() => this.tui.requestRender(), 1000);
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
  async older() {
    if (!this.next) { this.note = "start of transcript"; this.changed(); return; }
    try {
      const page = await this.source.page(this.next);
      if (this.life.signal.aborted) return;
      for (const entry of page.entries) this.entries.set(String(entry.id), entry);
      this.next = page.next; this.olderLoaded = true; this.prepended = true; this.version++;
    } catch (error) { this.note = String(error); }
    this.changed();
  }
  changed() { this.cache = undefined; this.tui.requestRender(); }
  lines(width: number) {
    if (this.cache?.width !== width || this.cache.version !== this.version) {
      this.cache = { width, version: this.version, lines: renderTranscript([...this.entries.values()], this.name, width, this.theme, this.showThinking) };
    }
    const lines = this.cache.lines;
    // Keep a scrolled-up view anchored when activity is appended; prepending older pages needs no shift.
    if (this.lastLength?.width === width && lines.length !== this.lastLength.length && !this.prepended && this.offset > 0) {
      this.offset += lines.length - this.lastLength.length;
      if (lines.length > this.lastLength.length) this.unseen = true;
    }
    this.prepended = false; this.lastLength = { width, length: lines.length };
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
    const home = homedir();
    const cwd = s.cwd ? (s.cwd === home || s.cwd.startsWith(`${home}/`) ? `~${s.cwd.slice(home.length)}` : s.cwd) : "";
    return [s.model && `${s.model}${s.thinking ? ` ${s.thinking}` : ""}`, time, formatContext(s), formatCost(s.cost), cwd].filter(Boolean).join(" · ");
  }

  render(width: number) { return this.lines(width); }
  invalidate() { this.cache = undefined; }
  dispose() {
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
      t.fg("dim", "esc back · f follow-up · s steer · x stop · ↑↓ pgup/pgdn scroll · o older · t thinking · r refresh")].filter(Boolean).join(t.fg("dim", " · "));
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
    if (data === "t") { this.transcript.showThinking = !this.transcript.showThinking; this.transcript.version++; return this.transcript.changed(); }
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
  set focused(value: boolean) { this.editor.focused = value; }
  private transcript: Transcript;
  private editor: Editor;
  private actions: ChatActions;
  readonly layout: VStack;
  constructor(tui: TUI, theme: Theme, name: string, source: WorkerSource, parent: AbortSignal, actions: ChatActions, notice: () => string = () => "") {
    this.actions = actions;
    this.transcript = new Transcript(tui, theme, name, source, parent);
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.onSubmit = text => this.submit(text, "steer");
    const scroll = new ScrollView(this.transcript, { follow: "end", primary: true });
    const footer = { render: (width: number) => [truncateToWidth(theme.fg("dim", [name, this.transcript.details(Date.now()), this.transcript.note, notice()].filter(Boolean).join(" · ")), width), truncateToWidth(theme.fg("dim", "enter send · alt+enter follow-up · esc stop · ← back"), width)], invalidate() {} };
    this.layout = new VStack([{ component: scroll, grow: 1, basis: 0 }, this.editor, footer]);
  }
  private submit(text: string, mode: Mode) {
    if (!text.trim()) return;
    this.editor.setText("");
    void this.actions.send(text, mode).then(() => { this.editor.addToHistory(text); this.transcript.note = undefined; this.transcript.changed(); }, error => {
      if (!this.editor.getText()) this.editor.setText(text);
      this.transcript.note = String(error); this.transcript.changed();
    });
  }
  render(width: number) { return this.layout.render(width); }
  handleInput(data: string) {
    if (matchesKey(data, Key.left) && !this.editor.getText()) return this.actions.back();
    if (matchesKey(data, Key.escape)) { void this.actions.stop().catch(error => { this.transcript.note = String(error); this.transcript.changed(); }); return; }
    if (matchesKey(data, "alt+enter")) return this.submit(this.editor.getExpandedText(), "followUp");
    this.editor.handleInput(data);
  }
  invalidate() { this.transcript.invalidate(); this.editor.invalidate(); }
  dispose() { this.transcript.dispose(); }
}
