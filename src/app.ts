import { piCompletionTool } from "./presentation.ts";
import { archiveView, formatCost, olderFrom, OLDER_LABEL, recentFolders, statusWord, teamGlance } from "./status.ts";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { DirPicker } from "./dir-picker.ts";
import { agentNameError, suggestedAgentName } from "./agent-name.ts";
import type { ModelChoice } from "./model-choices.ts";
import { Editor, HStack, Key, SelectList, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type WorkerModel } from "./config.ts";
import type { AgentSummary } from "./protocol.ts";
import { workerSource, type HostSource } from "./source.ts";
import { withDraft } from "./chat.ts";
import { ChatView, RAIL_DASHBOARD_MIN, RAIL_MAIN_MIN, Rail, railWidth, agentCard, dimLine } from "./ui.ts";
import { cmuxTab } from "./cmux.ts";
import { markdownForSelection } from "./copy.ts";

/** Screen-local selection and drafts only; all agent state comes from the host. */
export class AgentsApp implements Component, Focusable {
  private hasFocus = false;
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.updateFocus(); }
  private updateFocus() {
    this.editor.focused = this.hasFocus && (!!this.renaming || (!!this.form && (this.form.step === 0 || this.form.step === 2)));
    if (this.view) this.view.focused = this.hasFocus && !this.form && !this.confirming;
  }
  private doubleEscapeAction: "tree" | "fork" | "none";
  private source: HostSource; private tui: TuiAltScreen; private theme: Theme;
  private life = new AbortController(); private agents: AgentSummary[] = [];
  /** The host's full roster; `agents` is the active or archived view of it (tab toggles). */
  private allAgents: AgentSummary[] = []; private showArchived = false; private archivedCount = 0; private showKeys = false;
  /** The active view's selection, restored when leaving the archived view. */
  private activeSelected = 0;
  private setRoster(rows: AgentSummary[]) {
    this.allAgents = rows;
    ({ agents: this.agents, archivedCount: this.archivedCount } = archiveView(rows, this.showArchived));
    if (!this.archivedCount && this.showArchived) this.toggleArchived();
  }
  private toggleArchived() {
    if (!this.showArchived) this.activeSelected = this.selected;
    this.showArchived = !this.showArchived;
    this.selected = this.showArchived ? 0 : this.activeSelected;
    this.agents = archiveView(this.allAgents, this.showArchived).agents;
  }
  private stack: string[] = [];
  private branches = new Map<string, string>();
  private loadBranch(cwd?: string) {
    if (!cwd || this.branches.has(cwd)) return;
    this.branches.set(cwd, "");
    execFile("git", ["-C", cwd, "branch", "--show-current"], { timeout: 5000 }, (error, stdout) => {
      if (!error) this.branches.set(cwd, stdout.trim());
      if (!this.life.signal.aborted) this.tui.requestRender();
    });
  }
  private renaming?: { agent: AgentSummary; error?: string };
  private selected = 0; private view?: ChatView;
  /** The agent drawn on each row of the dashboard list, for clicks. */
  private listRows: (AgentSummary | undefined)[] = [];
  /** Unsent prompts by agent, so opening another agent and coming back keeps what was typed. */
  private drafts = new Map<string, string>(); private viewAgent?: string;
  /** `agent` as drawn: its asks less those its unsent prompt already answers (the open one's is in the editor). */
  private drafted(agent: AgentSummary) { return withDraft(agent, (agent.id === this.viewAgent ? this.view?.draft() : this.drafts.get(agent.id)) ?? ""); }
  private closeView() {
    if (this.view && this.viewAgent) { const text = this.view.draft(); if (text.trim()) this.drafts.set(this.viewAgent, text); else this.drafts.delete(this.viewAgent); }
    this.view?.dispose(); this.view = undefined; this.viewAgent = undefined;
  }
  private note = "Connecting…"; private editor: Editor;
  private lastCtrlC = 0;
  private form?: { step: number; name: string; cwd: string; nameEdited?: boolean; model?: WorkerModel; choices: ModelChoice[]; error?: string; creating?: boolean; loading?: boolean; folderRequest?: number };
  private picker?: SelectList;
  private dirPicker?: DirPicker;
  private confirming?: AgentSummary;
  private ticker?: ReturnType<typeof setInterval>;
  private frame = 0;
  private launchCwd: string;
  private exit: () => void;
  private removeInput: () => void;
  private cmux?: ReturnType<typeof cmuxTab>;
  constructor(source: HostSource, tui: TuiAltScreen, theme: Theme, options: { cwd?: string; exit?: () => void; cmux?: boolean; doubleEscapeAction?: "tree" | "fork" | "none" } = {}) {
    void piCompletionTool().catch(() => {});
    this.doubleEscapeAction = options.doubleEscapeAction ?? "tree";
    this.source = source; this.tui = tui; this.theme = theme;
    if (options.cmux) this.cmux = cmuxTab();
    this.launchCwd = options.cwd ?? process.cwd();
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.onSubmit = text => void (this.renaming ? this.rename(text) : this.advance(text));
    this.editor.onChange = text => {
      if (this.renaming) this.renaming.error = this.nameError(text.trim(), this.renaming.agent);
      else if (this.form?.step === 0) this.form.error = this.nameError(text.trim());
      else if (this.form?.step === 2) this.filterModels(text);
      else if (this.form) this.form.error = undefined;
    };
    this.exit = options.exit ?? (() => {});
    this.removeInput = tui.addInputListener(data => {
      // Kitty's keyboard protocol (on in Ghostty/cmux) sends ctrl+c as an escape sequence, not \x03, and also reports
      // the key's release; input listeners see that before the TUI drops it, and it must not count as a second press.
      if (isKeyRelease(data) || !matchesKey(data, Key.ctrl("c"))) return;
      // Pi's app.clear: one press clears the prompt, a second within 500 ms quits.
      const now = Date.now();
      if (now - this.lastCtrlC < 500) { this.dispose(); tui.stop(); this.exit(); return { consume: true }; }
      this.lastCtrlC = now;
      if (this.view && !this.form && !this.renaming) this.view.setDraft(""); else this.editor.setText("");
      tui.requestRender(); return { consume: true };
    });
    this.makeRails();
    this.setScreen();
    void this.roster();
  }
  private async roster() {
    let delay = 250;
    while (!this.life.signal.aborted) {
      try {
        await this.source.roster(this.life.signal, rows => {
          // Rows reorder by recency: keep the selection on the same agent.
          const selectedId = this.selectable()[this.selected]?.id;
          this.setRoster(rows);
          for (const { agent } of this.rows()) this.loadBranch(agent.cwd);
          const index = this.selectable().findIndex(agent => agent.id === selectedId);
          if (index >= 0) this.selected = index;
          this.view?.setChildren(this.rows().find(row => row.agent.id === this.stack.at(-1))?.agent.children ?? []); this.note = ""; delay = 250;
          const running = this.rows().some(row => row.agent.running);
          if (running && !this.ticker) this.ticker = setInterval(() => { this.frame++; this.tui.requestRender(); }, 100);
          if (!running && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
          this.updateCmux();
          this.tui.requestRender();
        });
      } catch { /* retry read-only subscription below */ }
      if (this.life.signal.aborted) return;
      this.note = "host disconnected — reconnecting…"; this.tui.requestRender();
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.life.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, delay); this.life.signal.addEventListener("abort", finish, { once: true });
      });
      delay = Math.min(5000, delay * 2);
    }
  }
  private title = "";
  private updateCmux() {
    const open = this.view ? this.rows().find(row => row.agent.id === this.stack.at(-1))?.agent : undefined;
    this.cmux?.update(this.agents, open);
    // Pi's terminal title, which cmux (and other terminals) show on the tab and workspace.
    const title = open ? `π - ${open.name} - ${basename(open.cwd ?? this.launchCwd)}` : `π - agents - ${basename(this.launchCwd)}`;
    if (title !== this.title) { this.title = title; this.tui.terminal.setTitle(title); }
  }
  private setScreen() {
    this.updateFocus(); this.updateCmux();
    const list = { render: (width: number) => this.list(width), invalidate() {},
      // A click opens the agent under it, as on the rails.
      handleMouse: (event: TuiMouseEvent) => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        const agent = this.listRows[event.y];
        if (!agent) return undefined;
        this.selected = Math.max(0, this.selectable().indexOf(agent)); this.open(agent);
        return { handled: true };
      } };
    const root = this.form || this.confirming || this.renaming ? this : this.panes ?? list;
    this.tui.setLayoutRoot(root);
  }
  /** The open agent beside read-only rails: the dashboard from 80 columns, the main agent above a sub-agent from 140. */
  private panes?: HStack;
  private dashboardRail!: Rail;
  private mainRail!: Rail;
  private makeRails() {
    const tree = (i: number, n: number) => i === n - 1 ? "└─ " : "├─ ";
    this.dashboardRail = new Rail(this.tui, this.theme, {
      width: columns => railWidth(columns, 0.16, 18, 28), frame: () => this.frame,
      onHeader: () => this.collapseTo(0), onOpen: worker => this.openFromRail(worker.id),
      content: () => {
        const lines = this.dashboard().map(({ agent, tree, summary }) => ({ worker: agent && this.drafted(agent), tree, text: summary, open: !!agent && this.stack.includes(agent.id) }));
        return { header: this.theme.fg("dim", " agents"), lines };
      },
    });
    this.mainRail = new Rail(this.tui, this.theme, {
      width: columns => railWidth(columns, 0.18, 18, 30), frame: () => this.frame,
      onHeader: () => this.collapseTo(1), onOpen: worker => this.openFromRail(worker.id),
      content: () => {
        const main = this.rows().find(row => row.agent.id === this.stack[0])?.agent;
        if (!main) return { header: "", lines: [] };
        // As everywhere: active sub-agents get a row, idle ones fold into the summary line.
        const { shown, summary } = teamGlance(main.children);
        const rows = summary ? shown.length + 1 : shown.length;
        return { header: ` ${this.theme.bold(main.name)}`, lines: [{ text: statusWord(main) },
          ...shown.map((child, i) => ({ worker: child, tree: tree(i, rows), open: child.id === this.stack[1] })),
          ...(summary ? [{ tree: "└─ ", text: summary }] : [])] };
      },
    });
  }
  /** Which panes beneath the open one are hidden at this width: their names lead the footer. */
  private path() {
    const columns = this.tui.terminal.columns;
    const names = this.stack.map(id => this.rows().find(row => row.agent.id === id)?.agent.name ?? "…");
    const hidden = columns < RAIL_DASHBOARD_MIN || (this.stack.length > 1 && columns < RAIL_MAIN_MIN);
    return hidden ? ["pi-agents", ...names].join(" › ") : "";
  }
  private buildPanes() {
    if (!this.view) { this.panes = undefined; return; }
    const sub = this.stack.length > 1;
    this.panes = new HStack([
      { component: this.dashboardRail, basis: "auto", grow: 0, shrink: 0, visible: ({ width }) => width >= RAIL_DASHBOARD_MIN },
      ...(sub ? [{ component: this.mainRail, basis: "auto" as const, grow: 0, shrink: 0, visible: ({ width }: { width: number }) => width >= RAIL_MAIN_MIN }] : []),
      { component: this.view.layout, basis: 0, grow: 1 },
    ], { gap: 1 });
  }
  /** Close every pane above `depth`: 0 is the dashboard, 1 the main agent. Rails and alt+1/alt+2 use it. */
  private collapseTo(depth: number) {
    if (depth >= this.stack.length) return;
    const child = this.stack[depth];
    this.stack = this.stack.slice(0, depth);
    const parent = this.rows().find(row => row.agent.id === this.stack.at(-1))?.agent;
    if (parent) { this.open(parent, false); if (child) this.view?.focusChild(child); }
    else {
      this.closeView(); this.panes = undefined;
      this.setScreen();
    }
    this.tui.requestRender();
  }
  private openFromRail(id: string) {
    const agent = this.rows().find(row => row.agent.id === id)?.agent;
    if (!agent || id === this.stack.at(-1)) return;
    // A sub-agent of the open main stacks on it; anything else starts from the dashboard.
    this.stack = this.stack[0] && this.rows().find(row => row.agent.id === this.stack[0])?.agent.children.some(child => child.id === id) ? [this.stack[0]] : [];
    this.open(agent);
  }
  private rows() {
    const out: { agent: AgentSummary; depth: number }[] = [];
    const visit = (agents: AgentSummary[], depth: number) => {
      for (const agent of agents) {
        out.push({ agent, depth }); visit(agent.children, depth + 1);
      }
    };
    visit(this.agents, 0); return out;
  }
  /**
   * Dashboard rows: each top-level agent, then its team at a glance as in Pi's panel. Running
   * sub-agents get a row; the rest fold into one summary line, listed only from the open agent's panel.
   */
  private dashboard() {
    const out: { agent?: AgentSummary; tree: string; summary?: string }[] = [];
    const older = this.showArchived ? -1 : olderFrom(this.agents);
    for (const [index, agent] of this.agents.entries()) {
      if (index === older) out.push({ tree: "", summary: `── ${OLDER_LABEL} ──` });
      out.push({ agent, tree: "" });
      if (!agent.children.length) continue;
      const { shown, summary } = teamGlance(agent.children);
      const children = shown.map(w => agent.children.find(child => child.id === w.id)!);
      children.forEach((child, i) => out.push({ agent: child, tree: i === children.length - 1 && !summary ? "└─ " : "├─ " }));
      if (summary) out.push({ tree: "└─ ", summary });
    }
    return out;
  }
  private selectable() { return this.dashboard().flatMap(row => row.agent ? [row.agent] : []); }
  private fail(error: unknown) { this.note = String(error); this.tui.requestRender(); }
  private open(agent: AgentSummary, push = true) {
    if (push) {
      if (!this.stack.length) {
        const parent = this.rows().find(row => row.agent.children.some(child => child.id === agent.id));
        if (parent) this.stack.push(parent.agent.id);
      }
      this.stack.push(agent.id);
    }
    this.closeView();
    this.loadBranch(agent.cwd);
    const bound = workerSource(this.source, agent.id);
    this.view = new ChatView(this.tui, this.theme, agent.name, bound, this.life.signal, {
      send: (text, mode, images) => this.source.send(agent.id, text, mode, { images }), stop: () => this.source.stop(agent.id),
      compact: instructions => this.source.compact(agent.id, instructions),
      models: () => this.source.models(this.life.signal),
      setModel: (model, thinking) => this.source.setModel(agent.id, model.provider, model.modelId, thinking),
      tree: entryId => this.source.tree(agent.id, entryId),
      dequeue: () => this.source.dequeue(agent.id),
      doubleEscapeAction: this.doubleEscapeAction,
      ...(this.stack.length === 1 ? {
        inputs: () => this.source.inputs(agent.id),
        // Pi jumps into the fork; the chosen message waits in its editor.
        fork: async (before?: string, draft?: string) => {
          const { id } = await this.source.fork(agent.id, before);
          const rows = await this.source.list();
          const created = rows.find(row => row.id === id);
          if (!created) throw new Error("Fork created but not in the roster yet; open it from the list");
          this.setRoster(rows); this.stack = []; this.open(created);
          if (draft) this.view?.setDraft(draft);
        },
      } : {}),
      back: () => this.collapseTo(this.stack.length - 1),
    }, () => this.note, !this.rows().some(row => row.agent.children.some(child => child.id === agent.id)) ? { open: worker => {
      const child = this.rows().find(row => row.agent.id === worker.id)?.agent;
      if (child) this.open(child);
    } } : undefined, () => this.branches.get(agent.cwd ?? "") ?? "", () => this.path()); this.viewAgent = agent.id; this.view.setDraft(this.drafts.get(agent.id) ?? ""); this.view.setChildren(agent.children); this.buildPanes(); this.setScreen(); this.tui.requestRender();
  }
  private nameError(name: string, target?: AgentSummary) {
    const siblings = target ? this.rows().find(row => row.agent.children.some(child => child.id === target.id))?.agent.children ?? this.agents : this.agents;
    return agentNameError(name) ?? (siblings.some(agent => agent.id !== target?.id && agent.name === name)
      ? "Name already exists; reuse the agent or choose a distinct name" : undefined);
  }
  private async rename(text: string) {
    const rename = this.renaming; if (!rename) return;
    rename.error = this.nameError(text.trim(), rename.agent);
    if (!rename.error) {
      try { await this.source.rename(rename.agent.id, text.trim()); this.renaming = undefined; this.note = ""; }
      catch (error) { rename.error = String(error); }
    }
    if (rename.error) { const error = rename.error; this.editor.setText(text); rename.error = error; }
    this.setScreen(); this.tui.requestRender();
  }
  private filterModels(text: string) {
    const form = this.form; if (!form || form.step !== 2) return;
    const query = text.toLowerCase();
    const choices = form.choices.filter(model => `${model.provider}/${model.modelId}`.toLowerCase().includes(query) || (model.name ?? "").toLowerCase().includes(query));
    this.picker = new SelectList(choices.map(model => ({ value: `${model.provider}/${model.modelId}`, label: `${model.provider}/${model.modelId}`, description: model.name })), 8, getSelectListTheme());
    this.picker.onSelect = item => {
      const model = choices.find(model => `${model.provider}/${model.modelId}` === item.value)!;
      form.model = { provider: model.provider, modelId: model.modelId, thinking: form.model?.thinking };
      this.normalizeThinking(); this.formStep(4); this.tui.requestRender();
    };
  }
  private formStep(step: number) {
    const form = this.form; if (!form) return;
    form.folderRequest = (form.folderRequest ?? 0) + 1;
    form.loading = false;
    form.step = step; form.error = undefined; this.picker = undefined; this.dirPicker = undefined;
    if (step === 1) this.dirPicker = new DirPicker({
      cwd: form.cwd || undefined,
      theme: this.theme, recent: recentFolders(this.allAgents),
      height: () => Math.max(6, this.tui.terminal.rows - 4),
      onChoose: path => void this.advance(path), onCancel: () => this.formStep(4),
    });
    this.editor.setText(step === 0 ? form.name : "");
    if (step === 2) {
      this.filterModels("");
      const index = form.choices.findIndex(model => model.provider === form.model?.provider && model.modelId === form.model?.modelId);
      this.picker!.setSelectedIndex(Math.max(0, index));
    } else if (step === 3) {
      const levels = form.choices.find(model => model.provider === form.model?.provider && model.modelId === form.model?.modelId)!.thinkingLevels;
      this.picker = new SelectList(levels.map(level => ({ value: level, label: level })), 8, getSelectListTheme());
      const preferred = form.model?.thinking;
      this.picker.setSelectedIndex(Math.max(0, levels.indexOf(preferred && levels.includes(preferred) ? preferred : levels.includes("medium") ? "medium" : levels[0]!)));
      this.picker.onSelect = item => void this.advance(item.value);
    } else if (step === 4) {
      this.picker = new SelectList([
        { value: "create", label: "Create agent" },
        { value: "0", label: `Name: ${form.name} · edit` },
        { value: "1", label: `Working folder: ${form.cwd} · change` },
        { value: "2", label: `Model: ${form.model ? `${form.model.provider}/${form.model.modelId}` : "Choose a model"} · change` },
        { value: "3", label: `Thinking: ${form.model?.thinking ?? "Choose a model first"} · change` },
      ], 6, getSelectListTheme());
      this.picker.onSelect = item => {
        if (item.value === "create") void this.createAgent();
        else if (item.value === "3" && !form.model) this.formStep(2);
        else this.formStep(Number(item.value));
        this.tui.requestRender();
      };
    }
    this.updateFocus();
  }
  private normalizeThinking() {
    const form = this.form!;
    const levels = form.choices.find(choice => choice.provider === form.model?.provider && choice.modelId === form.model?.modelId)?.thinkingLevels;
    if (form.model && levels) form.model.thinking = form.model.thinking && levels.includes(form.model.thinking) ? form.model.thinking : levels.includes("medium") ? "medium" : levels[0];
  }
  private async createAgent() {
    const form = this.form; if (!form || form.creating || form.loading) return;
    form.error = this.nameError(form.name);
    if (!form.error && !form.model) form.error = "Choose a model before creating the agent";
    if (!form.error) {
      form.creating = true;
      try {
        const { id } = await this.source.newAgent({ name: form.name, cwd: form.cwd, model: form.model, thinking: form.model?.thinking });
        if (this.form !== form) return;
        this.form = undefined; this.note = "";
        // The first chat message is the task; creation itself starts no work.
        this.open({ id: id!, name: form.name, cwd: form.cwd, hosted: true, children: [] });
      } catch (error) { form.error = String(error); }
      finally { form.creating = false; }
    }
    this.tui.requestRender();
  }
  private async loadReview(cwd: string) {
    const form = this.form; if (!form) return;
    const request = (form.folderRequest ?? 0) + 1;
    form.folderRequest = request;
    form.loading = true;
    try {
      const [choices, defaults] = await Promise.all([this.source.models(this.life.signal), this.source.defaults(this.life.signal)]);
      if (this.form !== form || form.folderRequest !== request) return;
      form.choices = choices;
      form.cwd = cwd;
      if (!form.nameEdited) form.name = suggestedAgentName(form.cwd, this.allAgents.map(agent => agent.name));
      const available = (model: WorkerModel | null | undefined) => choices.some(choice => choice.provider === model?.provider && choice.modelId === model?.modelId);
      const model = available(form.model) ? form.model : defaults;
      form.model = available(model) ? model ?? undefined : undefined;
      this.normalizeThinking();
      this.formStep(4);
      if (!choices.length) form.error = "No models available; log in or configure models first";
    } catch (error) { if (this.form !== form || form.folderRequest !== request) return; form.loading = false; form.error = String(error); }
    this.tui.requestRender();
  }
  private async advance(text: string) {
    const form = this.form; if (!form) return;
    if (form.step === 0) {
      form.error = this.nameError(text.trim());
      if (!form.error) { form.name = text.trim(); form.nameEdited = true; this.formStep(4); }
    } else if (form.step === 1) {
      await this.loadReview(text.trim());
    } else if (form.step === 3) {
      form.model = { ...form.model!, thinking: text as WorkerModel["thinking"] };
      this.formStep(4);
    }
    if (form.error && form.step === 0) { const error = form.error; this.editor.setText(text); form.error = error; }
    this.tui.requestRender();
  }
  private list(width: number): string[] {
    const t = this.theme;
    const rows = this.dashboard(); const selectable = rows.filter(row => row.agent);
    this.selected = Math.max(0, Math.min(this.selected, selectable.length - 1));
    const height = this.tui.terminal.rows;
    const keys = this.showArchived ? ["↑↓ select · enter/→ open", "u unarchive · x delete · tab active · q quit"]
      : ["↑↓ select · enter/→ open · n new", `r rename · x archive${this.archivedCount ? " · tab archived" : ""} · q quit`];
    const hints = this.showKeys ? (width >= 75 ? [keys.join(" · ")] : keys) : [];
    // Cards and spacing as in the rails: two lines per agent, the selected one a tinted band.
    const blocks = rows.map(({ agent, tree, summary }, index) => agent
      ? agentCard(this.drafted(agent), width, t, { selected: rows[index] === selectable[this.selected], frame: this.frame, tree })
      : [dimLine(`${tree}${summary}`, width, t)]);
    const at = rows.indexOf(selectable[this.selected]!);
    const capacity = Math.max(2, height - 5 - hints.length);
    let start = 0;
    while (start < at && blocks.slice(start, at + 1).flat().length > capacity) start++;
    const body = blocks.slice(start).flat().slice(0, capacity);
    this.listRows = [undefined, undefined, ...rows.slice(start).flatMap((row, i) => blocks[start + i]!.map(() => row.agent))].slice(0, 2 + body.length);
    const lines = [t.fg("dim", ` ${this.showArchived ? "archived agents" : "agents"}`), "", ...body];
    while (lines.length < height - 2 - hints.length) lines.push("");
    const all = this.rows();
    const total = formatCost(all.reduce((sum, row) => sum + (row.agent.cost ?? 0), 0));
    const running = this.agents.filter(a => a.running).length;
    const summary = this.showArchived ? `${this.agents.length} archived` : `${running} running · ${this.agents.length - running} idle${this.archivedCount ? ` · ${this.archivedCount} archived` : ""} · total ${total || "$0.000"}${all.some(row => row.agent.subscription) ? " (sub)" : ""}`;
    const short = `${this.showArchived ? "u unarchive" : "n new"} · ? ${this.showKeys ? "hide keys" : "keys"}`;
    const gap = width - 2 - visibleWidth(summary) - visibleWidth(short);
    lines.push(dimLine(gap >= 2 ? summary + " ".repeat(gap) + short : `${summary} · ${short}`, width, t), this.note ? ` ${this.note}` : "", ...hints.map(line => dimLine(line, width, t)));
    return lines.map(line => truncateToWidth(line, width));
  }
  render(width: number): string[] {
    if (this.renaming) return ["Rename agent · enter save · esc cancel", ...this.editor.render(width), this.renaming.error ?? ""].map(line => truncateToWidth(line, width));
    if (this.form) {
      const form = this.form;
      return [`New agent · esc ${form.step === 4 ? "cancel" : "review"}`, form.cwd,
        ({ 0: "Name · enter save", 1: "Working directory", 2: "Model · type to filter · ↑↓ select · enter choose", 3: "Thinking · ↑↓ select · enter choose", 4: "Review · ↑↓ select · enter choose" } as Record<number, string>)[form.step]!,
        ...(form.step === 1 ? this.dirPicker!.render(width) : form.step === 0 || form.step === 2 ? this.editor.render(width) : []),
        ...(this.picker?.render(width) ?? []), form.creating ? "Creating…" : form.loading ? "Loading settings…" : "", form.error ? this.theme.fg("error", form.error) : ""].map(line => truncateToWidth(line, width));
    }
    if (this.confirming) { const { name, children } = this.confirming; return [`Delete ${name}${children.length ? ` and ${children.length} sub-agent${children.length === 1 ? "" : "s"}` : ""}? This can't be undone. y/n`].map(line => truncateToWidth(line, width)); }
    return this.view ? this.view.render(width).map(line => truncateToWidth(line, width)) : this.list(width);
  }
  handleInput(data: string) {
    if (this.renaming) {
      if (matchesKey(data, Key.escape)) this.renaming = undefined;
      else this.editor.handleInput(data);
    }
    else if (this.form) {
      if (this.form.creating) return;
      if (this.form.loading && this.form.step === 4) {
        if (matchesKey(data, Key.escape)) this.form = undefined;
      } else if (this.form.step === 1) this.dirPicker!.handleInput(data);
      else if (matchesKey(data, Key.escape)) {
        if (this.form.step === 4) this.form = undefined;
        else this.formStep(4);
      } else if (this.picker && (this.form.step === 3 || this.form.step === 4 || matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter))) this.picker.handleInput(data);
      else this.editor.handleInput(data);
    }
    else if (this.confirming) { const target = this.confirming; this.confirming = undefined; if (data === "y") void this.source.remove(target.id).catch(error => this.fail(error)); }
    // alt+1 the dashboard, alt+2 the main agent, from any open pane (Option+digit with Option-as-Alt on macOS).
    else if (this.view && (matchesKey(data, Key.alt("1")) || matchesKey(data, Key.alt("2")))) this.collapseTo(matchesKey(data, Key.alt("1")) ? 0 : 1);
    else if (this.view) this.view.handleInput(data);
    else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.selectable().length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) { const agent = this.selectable()[this.selected]; if (agent) this.open(agent); }
    else if (data === "r") {
      const agent = this.selectable()[this.selected];
      if (agent) { this.renaming = { agent }; this.editor.setText(agent.name); }
    }
    else if (data === "?") this.showKeys = !this.showKeys;
    else if (data === "q") { this.dispose(); this.tui.stop(); this.exit(); return; }
    else if (matchesKey(data, Key.tab) && (this.showArchived || this.archivedCount)) {
      this.toggleArchived();
    }
    // x archives, and in the archived view deletes. Archive is undoable, so only delete asks for confirmation.
    else if (data === "x" && !this.showArchived) { const agent = this.selectable()[this.selected]; if (agent) void this.source.archive(agent.id).catch(error => this.fail(error)); }
    else if (data === "u" && this.showArchived) { const agent = this.selectable()[this.selected]; if (agent) void this.source.unarchive(agent.id).catch(error => this.fail(error)); }
    else if (data === "x" && this.showArchived) { const agent = this.selectable()[this.selected]; if (agent) this.confirming = agent; }
    else if (data === "n" && !this.showArchived) {
      this.form = { step: 4, name: suggestedAgentName(this.launchCwd, this.allAgents.map(agent => agent.name)), cwd: this.launchCwd, choices: [] };
      this.note = ""; this.formStep(4); void this.loadReview(this.launchCwd);
    }
    this.setScreen();
    this.tui.requestRender();
  }
  invalidate() { this.view?.invalidate(); this.editor.invalidate(); }
  /** What copy-on-select puts on the clipboard: the markdown behind the selected text in the open chat. */
  copyText(selected: string) { return markdownForSelection(selected, this.view?.markdown() ?? []); }
  dispose() { this.life.abort(); this.view?.dispose(); clearInterval(this.ticker); this.removeInput(); this.cmux?.dispose(); }
}
