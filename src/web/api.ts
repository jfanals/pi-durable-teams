import { pairing } from "./pair.ts";
import type { WorkerStatus } from "../status.ts";
import type { ChatItem, Queued } from "../chat.ts";
export type Agent = WorkerStatus & { hosted: boolean; children: Agent[] };
export type Page = { items: ChatItem[]; queued?: Queued[]; next?: string };
export type Model = { provider: string; modelId: string; name?: string; thinkingLevels: string[]; thinking?: string; cycleThinking?: string; scoped?: boolean; thinkingMap?: Record<string, string> };
const supplied = new URL(location.href).searchParams.get("token");
if (supplied) {
  localStorage.setItem("pi-token", supplied);
  const url = new URL(location.href);
  url.searchParams.delete("token");
  history.replaceState(null, "", url);
}
export const token = () => localStorage.getItem("pi-token") ?? "";
// Unpair removes this browser's API access; the app files themselves are public.
export function unpair() {
  localStorage.removeItem("pi-token");
  document.body.innerHTML = pairing;
}
async function response(route: string, body: object, signal?: AbortSignal) {
  const res = await fetch(`/agents${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    unpair();
    throw new Error("Pair this phone: run pi-agents pair");
  }
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res;
}
export async function api<T = Record<string, unknown>>(route: string, body: object = {}): Promise<T> {
  return (await response(route, body)).json();
}
export const mutate = (route: string, body: object) =>
  api(route, { ...body, requestId: crypto.randomUUID() });
/** One reader, bounded to one NDJSON frame; abort closes the underlying fetch. */
export async function stream(
  route: string,
  body: object,
  signal: AbortSignal,
  receive: (value: any) => void,
  state: (retrying: boolean) => void,
) {
  let delay = 250;
  while (!signal.aborted && token()) {
    try {
      const res = await response(route, body, signal);
      state(false);
      delay = 250;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (line) receive(JSON.parse(line));
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      /* A disconnected read is safe to retry; mutations never retry. */
    }
    if (signal.aborted || !token()) return;
    state(true);
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
    });
    delay = Math.min(10000, delay * 2);
  }
}
