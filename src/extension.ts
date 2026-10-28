import { textOf, liveStatus, statusWord, type WorkerStatus } from "./status.ts";
import { selectableModels } from "./model-choices.ts";
import { randomUUID } from "node:crypto";
import { realpath, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { CustomEditor, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { Client } from "./client.ts";
import { ActionSchema, IDENTITY_TYPE, MESSAGE_TYPE, SENT_TYPE, TOOL_DESCRIPTION, TOOL_NAME, type Delivery, type Mode } from "./protocol.ts";
import { agentDir, stateDir } from "./paths.ts";
import { contextLimit, LIMIT_PRESETS, writeContextLimit } from "./limits.ts";
import { readConfig, writeWorkerModels, type WorkerModel } from "./config.ts";
import { glyph, renderDelivery, renderSent, renderTeamCall, renderTeamResult, TeamPanel, teamResultSummary, WorkerView, type ViewResult } from "./ui.ts";

export default function durableTeams(pi: ExtensionAPI, createClient = () => new Client()) {
  let active: { ctx: ExtensionContext; sessionId: string; secret: string; life: AbortController; client: Client; queued: Set<string> } | undefined;
  async function saveResult(text: string) {
    const directory = join(stateDir, "results"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID()}.json`); await writeFile(path, text, { mode: 0o600 });
    return path;
  }
  const seen = (ctx: ExtensionContext, id: string) => ctx.sessionManager.getEntries().some(entry =>
    entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && (entry.details as { id?: string })?.id === id);
  const credentials = (current: NonNullable<typeof active>) => ({ sessionId: current.sessionId, secret: current.secret });
  const notify = (current: NonNullable<typeof active>, text: string, error = false) => {
    if (active === current && !current.life.signal.aborted) current.ctx.ui.setStatus("durable-teams", text);
    if (error && active === current) current.ctx.ui.notify(text, "error");
  };
  async function acknowledge(current: NonNullable<typeof active>, id: string) {
    // sendMessage can queue only in memory. Acknowledge only AFTER Pi has persisted the message.
    if (!seen(current.ctx, id)) return;
    await current.client.call("ack", { ...credentials(current), id }, current.life.signal);
    current.queued.delete(id);
  }
  async function receive(current: NonNullable<typeof active>, delivery: Delivery) {
    if (active !== current || current.life.signal.aborted) return;
    if (seen(current.ctx, delivery.id)) return acknowledge(current, delivery.id);
    if (current.queued.has(delivery.id)) return;
    current.queued.add(delivery.id);
    void refreshRoster(current);
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: `[${delivery.from.name} (${delivery.from.id})${delivery.request ? `; request ${delivery.request}` : ""}]\n${delivery.text}\n\nNo acknowledgement is needed. Reply with team/send only if there is an actionable follow-up.`,
      display: true, details: delivery,
    }, { triggerTurn: true, deliverAs: delivery.mode === "steer" ? "steer" : "followUp" });
  }
  function lastAssistant(ctx: ExtensionContext) {
    const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
    return textOf(entry.message);
  }
  async function register(current: NonNullable<typeof active>) {
    const { ctx } = current;
    if (!ctx.model) throw new Error("Select a Pi model before joining a Durable team");
    return current.client.call("register", {
      ...credentials(current), name: ctx.sessionManager.getSessionName() ?? `Main ${current.sessionId.slice(0, 8)}`,
      cwd: ctx.cwd, model: { provider: ctx.model.provider, modelId: ctx.model.id },
      thinking: pi.getThinkingLevel(), latest: lastAssistant(ctx),
    }, current.life.signal);
  }
  async function connect(current: NonNullable<typeof active>) {
    let backoff = 250;
    while (!current.life.signal.aborted && active === current) {
      try {
        await current.client.ensureHost(current.life.signal);
        await register(current);
        current.ctx.ui.setStatus("durable-teams", undefined); // connection problems only; the panel shows workers
        void refreshRoster(current);
        await current.client.stream("events", credentials(current), current.life.signal, value => receive(current, value.delivery));
      } catch (error) {
        if (current.life.signal.aborted) return;
        notify(current, `team disconnected: ${error instanceof Error ? error.message : error}`);
        // A second live process with this identity must not compete indefinitely.
        if (String(error).includes("already has a connected client") || String(error).includes("secret mismatch")) {
          notify(current, String(error), true); return;
        }
      }
      try { await delay(backoff, undefined, { signal: current.life.signal }); } catch { return; }
      backoff = Math.min(backoff * 2, 5000);
    }
  }
  type Current = NonNullable<typeof active>;
  const call = (current: Current, args: object, requestId?: string, signal?: AbortSignal) =>
    current.client.call("action", { ...credentials(current), args, ...(requestId ? { requestId } : {}) }, signal ?? current.life.signal);
  async function roster(current: Current): Promise<WorkerStatus[]> {
    const listed = await call(current, { action: "list" }) as { id: string; name: string; role: string; enabled?: boolean }[];
    return Promise.all(listed.filter(agent => agent.role === "worker").map(async agent => agent.enabled === false
      ? { id: agent.id, name: agent.name, enabled: false }
      : liveStatus({ ...agent, ...await call(current, { action: "inspect", target: agent.id }) })));
  }
  // Team panel under the prompt, fed from committed host state. Refreshed after our actions and
  // deliveries, and polled every 2 s while some worker runs; the clock and spinner tick locally.
  let polling: ReturnType<typeof setTimeout> | undefined;
  let panel: TeamPanel | undefined;
  let rosterRun = 0; // only the newest refresh renders and schedules, so overlapping calls never fork polling chains
  // Inside cmux, a pill on the workspace card shows how many workers are running; hidden when none are.
  // One key per Pi tab; --pid lets cmux drop it if this process dies. Sent only when the text changes.
  const pillKey = process.env.CMUX_WORKSPACE_ID && `durable-teams-${process.env.CMUX_SURFACE_ID ?? process.pid}`;
  let pill = "";
  function setPill(running: number) {
    const text = running ? `${running} ${running === 1 ? "worker" : "workers"}` : "";
    if (!pillKey || text === pill) return;
    pill = text;
    void pi.exec("cmux", text
      ? ["set-status", pillKey, text, "--icon", "person.2.fill", "--color", "#0A84FF", "--priority", "70", "--pid", String(process.pid)]
      : ["clear-status", pillKey], { timeout: 2000 }).catch(() => undefined);
  }
  async function refreshRoster(current: Current) {
    if (polling) clearTimeout(polling);
    polling = undefined;
    const run = ++rosterRun;
    try {
      const workers = await roster(current);
      if (run !== rosterRun || active !== current || current.life.signal.aborted) return;
      panel?.setWorkers(workers);
      setPill(workers.filter(worker => worker.running).length);
      if (workers.some(worker => worker.running)) polling = setTimeout(() => void refreshRoster(current), 2000);
    } catch {
      // Connection problems are reported by connect(); keep retrying so the panel recovers.
      if (run === rosterRun && active === current && !current.life.signal.aborted) polling = setTimeout(() => void refreshRoster(current), 5000);
    }
  }
  // Down in an empty main prompt (past the end of input history) moves into the team panel.
  // Pi exposes only a global input hook, so require that the main editor itself has focus:
  // dialogs, overlays and our own views keep their own Down key.
  let unsubscribeInput: (() => void) | undefined;
  let opening = false;
  function mountPanel(ctx: ExtensionContext) {
    unsubscribeInput?.(); unsubscribeInput = undefined; panel = undefined;
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("durable-teams", (tui, theme) => {
      panel = new TeamPanel(tui, theme, worker => {
        const current = active;
        if (!current || opening) return;
        opening = true;
        void openWorker(current, ctx, worker)
          .catch(error => ctx.ui.notify(String(error instanceof Error ? error.message : error), "error"))
          .finally(() => { opening = false; void refreshRoster(current); });
      });
      return panel;
    }, { placement: "belowEditor" });
    unsubscribeInput = ctx.ui.onTerminalInput(data => {
      // Releases count too: the press that leaves history for a blank prompt must not also open the panel.
      if (!panel?.hasWorkers || opening || isKeyRelease(data) || !matchesKey(data, Key.down)) return undefined;
      const focused = panel.currentFocus();
      if (!(focused instanceof CustomEditor) || ctx.ui.getEditorText() !== "") return undefined;
      panel.enter(focused);
      return { consume: true };
    });
  }
  pi.on("session_start", (_event, ctx) => {
    active?.life.abort(); if (polling) clearTimeout(polling);
    mountPanel(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const saved = ctx.sessionManager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === IDENTITY_TYPE && (entry.data as { sessionId?: string })?.sessionId === sessionId);
    const secret = saved?.type === "custom" ? (saved.data as { secret: string }).secret : randomUUID();
    if (!saved) pi.appendEntry(IDENTITY_TYPE, { sessionId, secret });
    const current = { ctx, sessionId, secret, life: new AbortController(), client: createClient(), queued: new Set<string>() };
    active = current;
    void connect(current);
  });
  pi.on("session_shutdown", () => {
    active?.life.abort(); if (polling) clearTimeout(polling); active = undefined; setPill(0);
    unsubscribeInput?.(); unsubscribeInput = undefined;
  });
  pi.on("message_end", async (event, ctx) => {
    const current = active;
    if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
    try {
      if (event.message.role === "custom" && event.message.customType === MESSAGE_TYPE) {
        await acknowledge(current, (event.message.details as Delivery).id);
      } else if (event.message.role === "assistant") {
        const latest = textOf(event.message);
        await current.client.call("publish", { ...credentials(current), latest }, current.life.signal);
      }
    } catch (error) { if (!current.life.signal.aborted) notify(current, `team publication pending: ${String(error)}`); }
  });
  pi.on("agent_settled", async () => {
    const current = active;
    if (!current) return;
    for (const id of current.queued) {
      try { await acknowledge(current, id); } catch { /* pending remains in Durable until reconnection */ }
    }
    if ([...current.queued].some(id => !seen(current.ctx, id))) notify(current, "team report pending: queued input was not persisted; /team reconnect when ready");
  });
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => renderDelivery(message, options, theme));
  pi.registerEntryRenderer(SENT_TYPE, (entry, { expanded }, theme) => renderSent(entry.data as any, expanded, theme));
  pi.registerTool({
    name: TOOL_NAME, label: "Durable team", description: TOOL_DESCRIPTION, parameters: ActionSchema,
    renderCall: (args, theme, context) => renderTeamCall(args, theme, context),
    renderResult: (result, options, theme, context) => renderTeamResult(result, options, theme, context),
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      const current = active;
      if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Team session not initialized");
      current.ctx = ctx;
      if (args.action === "spawn") args = { ...args, cwd: await realpath(resolve(ctx.cwd, args.cwd ?? ctx.cwd)) };
      if (args.action === "stop" && args.team && (!ctx.hasUI || !await ctx.ui.confirm("Stop Durable team?", "Pause this team, stop its workers/reporters, and withdraw pending worker reports?"))) throw new Error("Team stop requires human confirmation; use /team stop");
      await current.client.ensureHost(signal);
      await register(current); // model/name changes apply to newly spawned workers
      if (active !== current) throw new Error("Originating session changed");
      const source = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "toolCall" && (part.id === toolCallId || toolCallId.startsWith(`${part.id}/`))));
      if (!source) throw new Error("Cannot correlate this tool call with a persisted assistant entry");
      const result = await current.client.call("action", { ...credentials(current), args, requestId: `${source.id}:${toolCallId}` }, signal);
      let text = JSON.stringify(result, null, 2);
      if (text.length > 30_000) {
        const path = await saveResult(text);
        text = `${text.slice(0, 5000)}\n[Full result: ${path}]`;
      }
      if (args.action !== "inspect") void refreshRoster(current);
      return { content: [{ type: "text", text }], details: result };
    },
  });
  async function openWorker(current: Current, ctx: ExtensionContext, worker: WorkerStatus): Promise<"back" | "close"> {
    const source = {
      images: (entryId: string) => current.client.call<import("@earendil-works/pi-ai").ImageContent[]>("agents/images", { target: worker.id, entryId }),
      page: (cursor?: string) => current.client.call("page", { ...credentials(current), target: worker.id, cursor }),
      status: async () => liveStatus({ ...worker, ...await call(current, { action: "inspect", target: worker.id }) }),
      watch: (signal: AbortSignal, onFrame: () => void) => current.client.stream("watch", { ...credentials(current), target: worker.id }, signal, () => onFrame()),
    };
    while (active === current) {
      const result = await ctx.ui.custom<ViewResult>((tui, theme, _keys, done) => new WorkerView(tui, theme, worker.name, source, done, current.life.signal),
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } });
      if (!result || result.type === "back") return "back";
      if (result.type === "stop") {
        if (await ctx.ui.confirm(`Stop ${worker.name}?`, "Abort its current work and withdraw its pending reports. A stopped worker cannot be restarted; its transcript stays readable.")) {
          await call(current, { action: "stop", target: worker.id }, randomUUID());
          ctx.ui.notify(`${worker.name} stopped`, "info"); void refreshRoster(current);
        }
        continue;
      }
      await compose(current, ctx, worker, result.mode);
    }
    return "close";
  }
  async function compose(current: Current, ctx: ExtensionContext, worker: WorkerStatus, mode: Mode) {
    const label = mode === "steer" ? "Steer" : "Follow-up";
    let draft = "", requestId = randomUUID();
    for (;;) {
      const text = await ctx.ui.editor(`${label} → ${worker.name}  (${mode === "steer" ? "joins at its next tool boundary" : "queued after its current work"})`, draft);
      if (!text?.trim()) return;
      if (text !== draft) { draft = text; requestId = randomUUID(); } // retry an unchanged draft with the same request ID
      try {
        const result = await call(current, { action: "send", target: worker.id, message: text, mode }, requestId) as { taskId?: number };
        pi.appendEntry(SENT_TYPE, { target: worker.name, mode, text, request: result.taskId === undefined ? undefined : String(result.taskId) });
        ctx.ui.notify(`Accepted by ${worker.name}; its report will arrive here`, "info"); void refreshRoster(current);
        return;
      } catch (error) {
        ctx.ui.notify(`Not sent: ${error instanceof Error ? error.message : error}. Your draft is kept; submitting it unchanged retries the same request.`, "error");
      }
    }
  }
  async function pickWorker(current: Current, ctx: ExtensionContext) {
    let workers = await roster(current);
    for (;;) {
      if (!workers.length) { ctx.ui.notify("No workers in this session yet", "info"); return; }
      const labels = workers.map(w => `${glyph(w)} ${w.name}  ${statusWord(w)}`);
      const picked = await ctx.ui.select("Team · this session", labels);
      const worker = picked === undefined ? undefined : workers[labels.indexOf(picked)];
      if (!worker || await openWorker(current, ctx, worker) === "close") return;
      workers = await roster(current);
    }
  }
  // Worker models live in the host's config.json; the host reads them on every spawn, so edits apply to the next worker.
  // Choices are Pi's scoped models, read live (all available models when none are scoped).
  // A model's context limit is Pi's per-model compaction setting, shared by every session on that model.
  async function editModels(ctx: ExtensionCommandContext) {
    for (;;) {
      const settings = SettingsManager.create(homedir(), agentDir); // the global settings the host reads
      const limit = (m: { provider: string; modelId: string }) => {
        const model = ctx.modelRegistry.find(m.provider, m.modelId);
        const percent = model && contextLimit(settings, model);
        return percent ? ` · compacts at ${percent}%` : "";
      };
      const label = (m?: WorkerModel) => m ? `${m.provider}/${m.modelId} · ${m.thinking ?? "parent's thinking"}${limit(m)}` : "parent's model";
      const config = await readConfig();
      const rules = Object.entries(config.workerModels ?? {});
      const rows = [`top-level agents  ${config.agentModel ? label(config.agentModel) : "choose when creating an agent"}`, `default  ${label(config.workerModel)}`, ...rules.map(([key, m]) => `name contains "${key}"  ${label(m)}`), "+ add name rule"];
      const picked = rows.indexOf(await ctx.ui.select("Team models · first matching name rule wins, else default", rows) ?? "");
      if (picked < 0) return;
      const save = (workerModel: WorkerModel | undefined, workerModels: Record<string, WorkerModel>) =>
        writeWorkerModels({ workerModel, workerModels: Object.keys(workerModels).length ? workerModels : undefined });
      if (picked === 0) {
        const model = await chooseModel(ctx, settings, "choose when creating an agent");
        if (model !== null) await writeWorkerModels({ agentModel: model, workerModel: config.workerModel, workerModels: config.workerModels });
        continue;
      }
      if (picked === 1) {
        const model = await chooseModel(ctx, settings, "parent's model");
        if (model !== null) await save(model, Object.fromEntries(rules));
        continue;
      }
      const key = picked === rows.length - 1 ? (await ctx.ui.input("Name contains", "e.g. review, test, docs"))?.trim() : rules[picked - 2]![0];
      if (!key) continue;
      if (picked < rows.length - 1 && await ctx.ui.select(`Rule "${key}"`, ["Change model", "Remove rule"]) === "Remove rule") {
        await save(config.workerModel, Object.fromEntries(rules.filter(([k]) => k !== key))); continue;
      }
      const model = await chooseModel(ctx, settings);
      if (model) await save(config.workerModel, { ...Object.fromEntries(rules), [key]: model });
    }
  }
  /** A model, thinking level and context limit; undefined for the `unset` row, null when cancelled. */
  async function chooseModel(ctx: ExtensionCommandContext, settings: SettingsManager, unset?: string): Promise<WorkerModel | undefined | null> {
    const models = selectableModels(ctx.scopedModels, () => ctx.modelRegistry.getAvailable());
    if (!models.length) { ctx.ui.notify("No models available; log in or configure models first", "error"); return null; }
    const names = [...(unset ? [unset] : []), ...models.map(m => `${m.provider}/${m.id}`)];
    const picked = names.indexOf(await ctx.ui.select("Worker model", names) ?? "");
    if (picked < 0) return null;
    if (unset && picked === 0) return undefined;
    const model = models[picked - (unset ? 1 : 0)]!;
    const levels = ["parent's thinking", ...getSupportedThinkingLevels(model)];
    const thinking = await ctx.ui.select(`Thinking · ${model.id}`, levels);
    if (thinking === undefined) return null;
    if (model.contextWindow > 0) {
      const current = contextLimit(settings, model);
      const fallback = Math.round(100 * (model.contextWindow - settings.getCompactionReserveTokens()) / model.contextWindow);
      const options = [`keep ${current}%`, ...LIMIT_PRESETS.map(p => `${p}%`), ...(current === fallback ? [] : [`Pi default (${fallback}%)`])];
      const picked = await ctx.ui.select(`Compact at · % of ${model.id}'s ${Math.round(model.contextWindow / 1000)}k window, for every session on this model`, options);
      if (picked === undefined) return null;
      if (picked !== options[0]) {
        await writeContextLimit(model, picked.startsWith("Pi default") ? undefined : parseInt(picked));
        ctx.ui.notify("Context limit saved to Pi settings: new workers use it now; /reload applies it to this session", "info");
      }
    }
    return { provider: model.provider, modelId: model.id, ...(thinking === levels[0] ? {} : { thinking: thinking as WorkerModel["thinking"] }) };
  }
  pi.registerCommand("team", {
    description: "Durable team: open the worker view, or open <worker> | models | stop | resume | reconnect",
    getArgumentCompletions: prefix => ["open", "models", "stop", "resume", "reconnect"].filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c })),
    async handler(raw, ctx) {
      if (raw.trim() === "models") return editModels(ctx);
      const current = active;
      if (!current) throw new Error("No active team session");
      current.ctx = ctx;
      const [command = "", ...rest] = raw.trim().split(/\s+/).filter(Boolean);
      if (command === "reconnect") {
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Reconnect only while idle with no pending main input");
        current.life.abort();
        const next = { ...current, life: new AbortController(), queued: new Set<string>() }; active = next;
        void connect(next); return;
      }
      await current.client.ensureHost(); await register(current);
      if (command === "resume") {
        if (!await ctx.ui.confirm("Resume team?", "Allow new delegated work? Stopped workers remain stopped.")) return;
        await current.client.call("resume", credentials(current)); ctx.ui.notify("Team resumed", "info"); return;
      }
      if (command === "stop") {
        if (!await ctx.ui.confirm("Stop Durable team?", "Pause delegation and stop every worker/report task in this team? Other teams are untouched.")) return;
        const result = await call(current, { action: "stop", team: true }, randomUUID());
        ctx.ui.notify(teamResultSummary({ action: "stop", team: true }, result), "info"); void refreshRoster(current); return;
      }
      if (command && command !== "open") throw new Error("Use /team, /team open <worker>, /team models, /team stop, /team resume or /team reconnect");
      if (ctx.mode !== "tui") {
        const workers = await roster(current);
        ctx.ui.notify(workers.map(w => `${glyph(w)} ${w.name} · ${statusWord(w)}`).join("\n") || "No workers in this session", "info"); return;
      }
      const named = rest.join(" ");
      if (!named) return pickWorker(current, ctx);
      {
        const worker = (await roster(current)).find(w => w.name === named || w.id === named);
        if (!worker) throw new Error(`No worker named ${named} in this session`);
        await openWorker(current, ctx, worker);
      }
    },
  });
}
