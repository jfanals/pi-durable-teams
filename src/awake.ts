import { spawn, type ChildProcess } from "node:child_process";
import type { AgentSummary } from "./protocol.ts";

const busy = (rows: readonly AgentSummary[]): boolean => rows.some(row => (row.hosted && row.running) || busy(row.children));

/** Keeps macOS from idle-sleeping while any hosted agent runs, like a video player does. */
export function keepAwake(service: {
  agents: () => Promise<AgentSummary[]>;
  subscribe: (listener: () => void) => () => void;
}, hold = () => spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })) {
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false; let checking = false; let dirty = false;
  const release = () => { child?.kill(); child = undefined; };
  const check = async () => {
    timer = undefined;
    if (checking) { dirty = true; return; }
    checking = true;
    try {
      const want = busy(await service.agents());
      if (stopped) return;
      if (want && !child) {
        const held = child = hold();
        const gone = () => { if (child === held) child = undefined; };
        held.on("error", error => { gone(); console.error("Keep awake:", error.message); });
        held.on("exit", gone);
      } else if (!want) release();
    } catch (error) { console.error("Keep awake:", error instanceof Error ? error.message : error); }
    finally { checking = false; if (dirty) { dirty = false; schedule(); } }
  };
  // Coarse coalescing: sleep needs minutes, so commits never cost more than one roster read a second.
  const schedule = () => { if (!timer && !stopped) timer = setTimeout(() => { void check(); }, 1000); };
  const unsubscribe = service.subscribe(schedule);
  schedule();
  return { close: () => { stopped = true; clearTimeout(timer); unsubscribe(); release(); } };
}
