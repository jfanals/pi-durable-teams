export type WorkerStatus = {
  id: string; name: string; enabled: boolean; running?: boolean;
  /** Plain-words current activity while running: "reading src/ui.ts", "thinking", … */
  activity?: string;
  /** Start of the current or last request; end of the last answer. */
  since?: number; finishedAt?: number;
  /** List-price cost so far; subscription when its provider bills by subscription, not by this price. */
  cost?: number; subscription?: boolean;
  /** Short model label and thinking level, e.g. "opus-5-5" and "medium". */
  model?: string; modelId?: string; provider?: string; thinking?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cacheHit?: number;
  /** Prompt size of the latest reply and the model's window; working directory. */
  context?: number; contextWindow?: number; cwd?: string;
};

/** Strip terminal escape sequences and unsafe controls, preserving text layout. */
export const clean = (value: unknown): string => String(value ?? "")
  .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
  .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
  .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[ -/]*[@-Z\\-_]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export const firstLine = (text: unknown) => clean(text).split("\n").find(line => line.trim())?.trim() ?? "";
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
export const replyTokens = (u: any) => (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0);
export function liveStatus(worker: { id: string; name: string; enabled?: boolean; agent?: any; live?: any; usage?: any; latest?: any; since?: unknown; contextWindow?: unknown; subscription?: unknown }): WorkerStatus {
  const running = Boolean(worker.live?.run);
  const buckets = Object.values(worker.usage?.models ?? {}) as any[];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const bucket of buckets) for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[key] += bucket?.[key] ?? 0;
  const modelId = worker.agent?.model?.modelId ?? worker.latest?.model;
  const prompt = worker.latest?.usage;
  const promptTokens = (prompt?.input ?? 0) + (prompt?.cacheRead ?? 0) + (prompt?.cacheWrite ?? 0);
  const thinking = worker.agent?.thinkingLevel ?? worker.latest?.providerThinkingLevel;
  return {
    id: worker.id, name: worker.name, enabled: worker.enabled !== false, running,
    activity: running ? describe(worker.live, worker.latest) : undefined,
    since: typeof worker.since === "number" ? worker.since : undefined,
    finishedAt: typeof worker.latest?.timestamp === "number" ? worker.latest.timestamp : undefined,
    tokens, modelId: typeof modelId === "string" ? clean(modelId) : undefined,
    provider: worker.agent?.model?.provider ?? worker.latest?.provider,
    cacheHit: promptTokens ? 100 * (prompt.cacheRead ?? 0) / promptTokens : undefined,
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
export const formatAgo = (ms: number) => ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : `${Math.floor(ms / 3_600_000)}h ago`;
// Pi footer formats: tokens "950", "4.2k", "188k", "1.0M"; context "18.8%/1M"; cost "$9.812".
export const formatTokens = (n: number) => n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k`
  : n < 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1_000_000)}M`;
export const formatContext = (w: WorkerStatus) => w.context === undefined ? ""
  : w.contextWindow ? `${(100 * w.context / w.contextWindow).toFixed(1)}%/${formatTokens(w.contextWindow)}` : `${formatTokens(w.context)} ctx`;
export const formatCost = (cost?: number) => cost ? `$${cost.toFixed(3)}` : "";

/** Idle workers keep their own row this long after their last reply, then join the summary count. */
export const RECENT_MS = 60_000;
export const recent = (w: WorkerStatus, now: number) => w.enabled && !w.running && !!w.finishedAt && now - w.finishedAt < RECENT_MS;
/**
 * A team at a glance, the same in Pi's panel, the dashboard and the web list: running and
 * recently finished workers get their own row (up to `limit`); the rest are counted, with the team's cost.
 */
export function teamGlance(workers: WorkerStatus[], now: number, limit = Infinity) {
  const shown = [...workers.filter(w => w.running), ...workers.filter(w => recent(w, now))];
  const idle = workers.filter(w => w.enabled && !w.running && !shown.includes(w)).length;
  const stopped = workers.filter(w => !w.enabled).length;
  const cost = formatCost(workers.reduce((sum, w) => sum + (w.cost ?? 0), 0));
  const summary = [shown.length > limit && `+${shown.length - limit} more`, idle && `${idle} idle`, stopped && `${stopped} stopped`,
    cost && `team ${cost}${workers.some(w => w.subscription) ? " (sub)" : ""}`].filter(Boolean).join(" · ");
  const expires = shown.filter(w => !w.running).map(w => w.finishedAt! + RECENT_MS);
  return { shown: shown.slice(0, limit), summary, ...(expires.length ? { expiresAt: Math.min(...expires) } : {}) };
}


export const textOf = (message: any): string => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).flatMap((part: any) => part.type === "text" ? [part.text] : []).join("\n");

/** The terminal and phone show the same usage line. */
export function formatUsage(w?: WorkerStatus): string {
  const u = w?.tokens;
  const context = w?.contextWindow
    ? `${(100 * (w.context ?? 0) / w.contextWindow).toFixed(1)}%/${formatTokens(w.contextWindow)}`
    : w?.context ? `${formatTokens(w.context)} ctx` : "";
  return [
    `↑${formatTokens(u?.input ?? 0)} ↓${formatTokens(u?.output ?? 0)}`,
    `R${formatTokens(u?.cacheRead ?? 0)} W${formatTokens(u?.cacheWrite ?? 0)}`,
    `CH${(w?.cacheHit ?? 0).toFixed(1)}% $${(w?.cost ?? 0).toFixed(3)}${w?.subscription ? " (sub)" : ""}`,
    context,
  ].filter(Boolean).join(" ");
}
