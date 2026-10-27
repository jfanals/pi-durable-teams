import { formatCost } from "./status.ts";
import { execFile } from "node:child_process";
import { DirPicker } from "./dir-picker.ts";
import { agentNameError, suggestedAgentName } from "./agent-name.ts";
import type { ModelChoice } from "./model-choices.ts";
import { Editor, Key, SelectList, isKeyRelease, matchesKey, truncateToWidth, type Component, type Focusable, type TuiAltScreen } from "@earendil-works/pi-tui";
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type WorkerModel } from "./config.ts";
import type { AgentSummary } from "./protocol.ts";
import { workerSource, type HostSource } from "./source.ts";
import { ChatView, statusRow } from "./ui.ts";
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
  private note = "Connecting…"; private editor: Editor;
  private lastCtrlC = 0;
  private form?: { step: number; name: string; cwd: string; nameEdited?: boolean; model?: WorkerModel; choices: ModelChoice[]; error?: string; creating?: boolean; loading?: boolean; folderRequest?: number };
  private picker?: SelectList;
  private dirPicker?: DirPicker;
  private confirming?: { agent: AgentSummary; remove?: boolean };
  private ticker?: ReturnType<typeof setInterval>;
  private frame = 0;
  private launchCwd: string;
  private exit: () => void;
  private removeInput: () => void;
  private cmux?: ReturnType<typeof cmuxTab>;
  constructor(source: HostSource, tui: TuiAltScreen, theme: Theme, options: { cwd?: string; exit?: () => void; cmux?: boolean; doubleEscapeAction?: "tree" | "fork" | "none" } = {}) {
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
    this.setScreen();
    void this.roster();
  }
  private async roster() {
    let delay = 250;
    while (!this.life.signal.aborted) {
      try {
        await this.source.roster(this.life.signal, rows => {
          // Rows reorder by recency: keep the selection on the same agent.
          const selectedId = this.rows()[this.selected]?.agent.id;
          this.agents = rows;
          for (const { agent } of this.rows()) this.loadBranch(agent.cwd);
          const index = this.rows().findIndex(row => row.agent.id === selectedId);
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
  private updateCmux() {
    this.cmux?.update(this.agents, this.view ? this.rows().find(row => row.agent.id === this.stack.at(-1))?.agent : undefined);
  }
  private setScreen() {
    this.updateFocus(); this.updateCmux();
    const list = { render: (width: number) => this.list(width), invalidate() {} };
    const root = this.form || this.confirming || this.renaming ? this : this.view?.layout ?? list;
    this.tui.setLayoutRoot(root);
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
  private fail(error: unknown) { this.note = String(error); this.tui.requestRender(); }
  private open(agent: AgentSummary, push = true) {
    if (push) {
      if (!this.stack.length) {
        const parent = this.rows().find(row => row.agent.children.some(child => child.id === agent.id));
        if (parent) this.stack.push(parent.agent.id);
      }
      this.stack.push(agent.id);
    }
    this.view?.dispose();
    this.loadBranch(agent.cwd);
    const bound = workerSource(this.source, agent.id);
    this.view = new ChatView(this.tui, this.theme, agent.name, bound, this.life.signal, {
      send: (text, mode, images) => this.source.send(agent.id, text, mode, { images }), stop: () => this.source.stop(agent.id),
      compact: instructions => this.source.compact(agent.id, instructions),
      models: () => this.source.models(this.life.signal),
      setModel: (model, thinking) => this.source.setModel(agent.id, model.provider, model.modelId, thinking),
      tree: entryId => this.source.tree(agent.id, entryId),
      doubleEscapeAction: this.doubleEscapeAction,
      ...(this.stack.length === 1 ? {
        inputs: () => this.source.inputs(agent.id),
        // Pi jumps into the fork; the chosen message waits in its editor.
        fork: async (before?: string, draft?: string) => {
          const { id } = await this.source.fork(agent.id, before);
          const rows = await this.source.list();
          const created = rows.find(row => row.id === id);
          if (!created) throw new Error("Fork created but not in the roster yet; open it from the list");
          this.agents = rows; this.stack = []; this.open(created);
          if (draft) this.view?.setDraft(draft);
        },
      } : {}),
      back: () => {
        const child = this.stack.pop();
        const parent = this.rows().find(row => row.agent.id === this.stack.at(-1))?.agent;
        if (parent) { this.open(parent, false); if (child) this.view?.focusChild(child); }
        else { this.stack = []; this.view?.dispose(); this.view = undefined; this.setScreen(); }
        this.tui.requestRender();
      },
    }, () => this.note, !this.rows().some(row => row.agent.children.some(child => child.id === agent.id)) ? { open: worker => {
      const child = this.rows().find(row => row.agent.id === worker.id)?.agent;
      if (child) this.open(child);
    } } : undefined, () => this.branches.get(agent.cwd ?? "") ?? ""); this.view.setChildren(agent.children); this.setScreen(); this.tui.requestRender();
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
      recent: this.rows().flatMap(({ agent }) => agent.cwd ? [agent.cwd] : []),
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
        this.open({ id: id!, name: form.name, cwd: form.cwd, enabled: true, hosted: true, children: [] });
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
      if (!form.nameEdited) form.name = suggestedAgentName(form.cwd, this.agents.map(agent => agent.name));
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
    const rows = this.rows(); this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const height = this.tui.terminal.rows;
    const hints = width >= 75 ? ["↑↓ select · enter/→ open · n new · r rename · x disable · d remove · q quit"]
      : ["↑↓ select · enter/→ open · n new", "r rename · x disable · d remove · q quit"];
    const capacity = Math.max(1, height - 4 - hints.length);
    const start = Math.max(0, this.selected - capacity + 1);
    const lines = [this.theme.fg("accent", this.theme.bold("pi-agents")), ""];
    const nameWidth = Math.min(24, Math.max(6, ...rows.map(({ agent, depth }) => 2 * depth + agent.name.length)));
    for (const [index, { agent: a, depth }] of rows.slice(start, start + capacity).entries()) {
      const display = { ...a, name: `${"  ".repeat(depth)}${a.name}` };
      lines.push(statusRow(display, width, index + start === this.selected, Date.now(), this.theme, nameWidth, this.frame, undefined, 60));
    }
    while (lines.length < height - 2 - hints.length) lines.push("");
    const all = this.rows();
    const total = formatCost(all.reduce((sum, row) => sum + (row.agent.cost ?? 0), 0));
    const running = this.agents.filter(a => a.running).length;
    const summary = `${running} running · ${this.agents.length - running} idle · total ${total || "$0.000"}${all.some(row => row.agent.subscription) ? " (sub)" : ""}`;
    lines.push(this.theme.fg("dim", summary), this.note, ...hints);
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
    if (this.confirming) return [this.confirming.remove ? `Remove ${this.confirming.agent.name}${this.confirming.agent.children.length ? ` and ${this.confirming.agent.children.length} sub-agent${this.confirming.agent.children.length === 1 ? "" : "s"}` : ""}? y/n` : `Disable ${this.confirming.agent.name}? y / n`].map(line => truncateToWidth(line, width));
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
    else if (this.confirming) { const target = this.confirming; this.confirming = undefined; if (data === "y") void (target.remove ? this.source.remove(target.agent.id) : this.source.disable(target.agent.id)).catch(error => this.fail(error)); }
    else if (this.view) this.view.handleInput(data);
    else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.rows().length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) { const row = this.rows()[this.selected]; if (row) this.open(row.agent); }
    else if (data === "r") {
      const agent = this.rows()[this.selected]?.agent;
      if (agent) { this.renaming = { agent }; this.editor.setText(agent.name); }
    }
    else if (data === "q") { this.dispose(); this.tui.stop(); this.exit(); return; }
    else if (data === "x" || data === "d") {
      const agent = this.rows()[this.selected]?.agent;
      if (agent) this.confirming = { agent, remove: data === "d" };
    }
    else if (data === "n") {
      this.form = { step: 4, name: suggestedAgentName(this.launchCwd, this.agents.map(agent => agent.name)), cwd: this.launchCwd, choices: [] };
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
