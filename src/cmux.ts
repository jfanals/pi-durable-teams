import { execFile, execFileSync } from "node:child_process";
import type { AgentSummary } from "./protocol.ts";

/**
 * Inside cmux: the tab shows the open agent's name, a sidebar pill shows what is running, and the tab flashes when a
 * top-level agent finishes. Outside cmux every call is a no-op. Commands go out only when their text changes.
 */
export function cmuxTab() {
  const inside = Boolean(process.env.CMUX_SURFACE_ID);
  const key = `pi-agents-${process.env.CMUX_SURFACE_ID}`;
  let queue = Promise.resolve();
  const run = (args: string[]) => {
    if (!inside) return;
    queue = queue.then(() => new Promise<void>(resolve => execFile("cmux", args, { timeout: 2000 }, () => resolve())));
  };
  let title = ""; let pill = ""; let running = new Set<string>();
  return {
    /** `open` is the agent on screen, if any; `agents` the top-level roster with children. */
    update(agents: AgentSummary[], open?: AgentSummary) {
      const nextTitle = open ? open.name : "Pi Agents";
      if (nextTitle !== title) { title = nextTitle; run(["rename-tab", "--", title]); }
      const all = agents.flatMap(function flat(a): AgentSummary[] { return [a, ...a.children.flatMap(flat)]; });
      const workingChildren = open ? open.children.filter(c => c.running).length : 0;
      const nextPill = open
        ? [open.running ? open.activity ?? "running" : "", workingChildren ? `${workingChildren} sub-agent${workingChildren === 1 ? "" : "s"} working` : ""].filter(Boolean).join(" · ")
        : (n => n ? `${n} running` : "")(all.filter(a => a.running).length);
      if (nextPill !== pill) {
        pill = nextPill;
        run(pill ? ["set-status", key, pill, "--icon", "sparkle", "--color", "#4C8DFF", "--priority", "70", "--pid", String(process.pid)] : ["clear-status", key]);
      }
      const now = new Set(agents.filter(a => a.running).map(a => a.id));
      if ([...running].some(id => !now.has(id) && agents.some(a => a.id === id))) run(["trigger-flash"]);
      running = now;
    },
    /** Synchronous: the app exits right after, and an async command would be cut off. */
    dispose() {
      const now = (args: string[]) => { try { execFileSync("cmux", args, { timeout: 2000, stdio: "ignore" }); } catch { /* cmux gone */ } };
      if (inside && title) now(["tab-action", "--action", "clear-name"]);
      if (inside && pill) now(["clear-status", key]);
      title = pill = "";
    },
  };
}
