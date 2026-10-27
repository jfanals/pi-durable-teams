// Pi's cache warming for hosted agents. Durable sends every model request through `models`; each agent conversation's
// requests drive one Pi CacheWarmer, which re-sends the last request with a one-token cap before its prompt cache
// expires, when Pi's rule expects it to save money. Same setting (`cacheWarming`: off, streaming, idle), timing and
// limits as Pi; each warm is an entry in the conversation, shown as Pi's "Cache warmed: $…" line.
import type { AssistantMessage, Models, Usage } from "@earendil-works/pi-ai";
import type { CommitPublication } from "@earendil-works/pi-durable";
import { piCacheWarming } from "./presentation.ts";

export const CACHE_WARM_KIND = "teams.cache-warm";
export type CacheWarmData = { provider: string; model: string; usage: Usage; note?: string; at: string };

type Store = {
  /** The conversation whose provider session is `sessionId`, if it is a hosted agent's. */
  conversationOf(sessionId: string): Promise<number | undefined>;
  record(conversationId: number, warm: CacheWarmData): Promise<void>;
};

export async function cacheWarming(getMode: () => string, store: Store, report: (error: unknown) => void) {
  const { CacheWarmer } = await piCacheWarming();
  const sessions = new Map<string, { warmer: InstanceType<typeof CacheWarmer>; last?: AssistantMessage; epoch: number; conversationId?: number }>();
  const byConversation = new Map<number, string>();
  const session = (sessionId: string, models: Models) => {
    let found = sessions.get(sessionId);
    if (found) return found;
    const state: { warmer?: InstanceType<typeof CacheWarmer>; last?: AssistantMessage; epoch: number; conversationId?: number } = { epoch: 0 };
    state.warmer = new CacheWarmer({ streamSimple: (...args: Parameters<Models["streamSimple"]>) => models.streamSimple(...args) }, {
      // Pi prices a warm from the last real request's prompt size.
      getBranch: () => state.last ? [{ type: "message", message: state.last }] : [],
      appendUsage: (kind: string, provider: string, model: string, usage: Usage, note?: string) => {
        const warm = { provider, model, usage, ...(note ? { note } : {}), at: new Date().toISOString() };
        if (state.conversationId !== undefined) store.record(state.conversationId, warm).catch(report);
        return { type: "usage", kind, ...warm, timestamp: warm.at };
      },
    }, getMode);
    found = state as typeof found & {};
    sessions.set(sessionId, found);
    store.conversationOf(sessionId).then(id => { if (id !== undefined) { state.conversationId = id; byConversation.set(id, sessionId); } }, report);
    return found;
  };
  const wrap = (models: Models): Models => new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") return (model: any, context: any, options?: any) => {
        const stream = target.streamSimple(model, context, options);
        const sessionId = options?.sessionId;
        if (typeof sessionId === "string" && getMode() !== "off") {
          const state = session(sessionId, target);
          const epoch = state.epoch;
          state.warmer.start({ model, context, options }, () => state.epoch === epoch);
          stream.result().then(message => { if (message.stopReason !== "error" && message.stopReason !== "aborted") state.last = message; }, () => {});
        }
        return stream;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    models: (models: Models | (() => Models)) => typeof models === "function" ? () => wrap(models()) : wrap(models),
    /** Commit listener: a settled run ends streaming warming; compaction, reset or an agent change ends the cached prefix. */
    onCommit(publication: CommitPublication) {
      for (const change of publication.changes) {
        const conversationId = change.type === "entry" ? change.value.conversationId : change.type === "document" ? change.conversationId : undefined;
        const sessionId = conversationId === undefined ? undefined : byConversation.get(conversationId);
        const state = sessionId === undefined ? undefined : sessions.get(sessionId);
        if (!state) continue;
        if (change.type === "entry" && ["pi.compaction", "pi.reset"].includes(change.value.kind)) state.epoch++;
        if (change.type === "document" && change.record.kind === "pi.agent") state.epoch++;
        if (change.type === "document" && change.record.kind === "pi.live" && "value" in change && change.value && !(change.value as { run?: unknown }).run) state.warmer.onAgentSettled();
      }
    },
    dispose() { for (const { warmer } of sessions.values()) warmer.cancel(); sessions.clear(); },
  };
}
