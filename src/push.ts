import webpush, { type PushSubscription } from "web-push";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSummary } from "./protocol.ts";
import { formatDuration } from "./status.ts";

/** Only top-level hosted running → idle transitions; an initial snapshot is not a finish. */
export function finished(previous: readonly AgentSummary[] | undefined, current: readonly AgentSummary[]): AgentSummary[] {
  if (!previous) return [];
  const running = new Set(previous.filter(a => a.hosted && a.running).map(a => a.id));
  return current.filter(a => a.hosted && a.running === false && running.has(a.id));
}

type State = { publicKey: string; privateKey: string; subject: string; subscriptions: Record<string, PushSubscription> };
const log = (error: unknown) => console.error("Web Push:", error instanceof Error ? error.message : error);

/** One private, atomic file holds stable VAPID identity and endpoint-keyed subscriptions. */
export function openPush(directory: string) {
  const path = join(directory, "push.json");
  const atomic = (state: State, create = false) => {
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      if (create) {
        try { linkSync(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } else renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  };
  if (!existsSync(path)) atomic({ ...webpush.generateVAPIDKeys(), subject: "mailto:pi-agents@example.com", subscriptions: {} }, true);
  const state = JSON.parse(readFileSync(path, "utf8")) as State;
  // Never silently replace a damaged identity: existing browser subscriptions depend on it.
  webpush.getVapidHeaders("https://example.com", state.subject, state.publicKey, state.privateKey, "aes128gcm");
  if (!state.subscriptions || typeof state.subscriptions !== "object" || Array.isArray(state.subscriptions)) throw new Error("Invalid push.json subscriptions");
  chmodSync(path, 0o600);
  const subscriptions = new Map(Object.entries(state.subscriptions));
  const save = () => atomic({ ...state, subscriptions: Object.fromEntries(subscriptions) });
  return {
    publicKey: state.publicKey,
    get active() { return subscriptions.size > 0; },
    subscribe(value: unknown) {
      const sub = value as PushSubscription;
      if (!sub || typeof sub.endpoint !== "string" || !sub.keys || typeof sub.keys.auth !== "string" || typeof sub.keys.p256dh !== "string") throw new Error("A PushSubscription with endpoint and keys is required");
      const url = new URL(sub.endpoint);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid push endpoint");
      if (Buffer.from(sub.keys.auth, "base64url").length !== 16 || Buffer.from(sub.keys.p256dh, "base64url").length !== 65) throw new Error("Invalid push subscription keys");
      const previous = subscriptions.get(sub.endpoint);
      subscriptions.set(sub.endpoint, { endpoint: sub.endpoint, keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh } });
      try { save(); } catch (error) { if (previous) subscriptions.set(sub.endpoint, previous); else subscriptions.delete(sub.endpoint); throw error; }
    },
    unsubscribe(endpoint: unknown) {
      if (typeof endpoint !== "string") throw new Error("endpoint is required");
      const previous = subscriptions.get(endpoint);
      subscriptions.delete(endpoint);
      try { save(); } catch (error) { if (previous) subscriptions.set(endpoint, previous); throw error; }
    },
    async send(agent: AgentSummary) {
      const duration = agent.since !== undefined && agent.finishedAt !== undefined ? formatDuration(agent.finishedAt - agent.since) : undefined;
      const payload = JSON.stringify({ title: `${agent.name} finished`, body: [agent.model, duration].filter(Boolean).join(" · "), agent: agent.id });
      await Promise.all([...subscriptions.values()].map(async sub => {
        try {
          await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: "normal", timeout: 10000,
            vapidDetails: { subject: state.subject, publicKey: state.publicKey, privateKey: state.privateKey } });
        } catch (error) {
          if ([404, 410].includes((error as { statusCode?: number }).statusCode ?? 0) && subscriptions.get(sub.endpoint) === sub) {
            subscriptions.delete(sub.endpoint);
            try { save(); } catch (cause) { log(cause); }
          }
          log(error);
        }
      }));
    },
  };
}

/** Host commit notifications are coalesced just like roster frames, with no reads while unused. */
export function watchPush(push: ReturnType<typeof openPush>, service: {
  agents: (connected: (id: string) => boolean) => Promise<AgentSummary[]>;
  subscribe: (listener: () => void) => () => void;
}, connected: (id: string) => boolean) {
  let previous: AgentSummary[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false; let dirty = false; let stopped = false;
  const flush = async () => {
    timer = undefined;
    if (running || stopped) return;
    running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        if (!push.active) { previous = undefined; continue; }
        const current = await service.agents(connected);
        const notifications = finished(previous, current);
        previous = current;
        for (const agent of notifications) void push.send(agent).catch(log);
      }
    } catch (error) { log(error); }
    finally { running = false; if (dirty) schedule(); }
  };
  const schedule = () => {
    if (!push.active) { previous = undefined; return; }
    dirty = true;
    if (!timer && !running && !stopped) timer = setTimeout(() => { void flush(); }, 25);
  };
  const unsubscribe = service.subscribe(schedule);
  schedule();
  return { schedule, close: () => { stopped = true; clearTimeout(timer); unsubscribe(); } };
}
