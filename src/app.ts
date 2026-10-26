import { DirPicker } from "./dir-picker.ts";
import { agentNameError } from "./agent-name.ts";
import type { ModelChoice } from "./model-choices.ts";
import { Editor, Key, SelectList, matchesKey, truncateToWidth, type Component, type Focusable, type TuiAltScreen } from "@earendil-works/pi-tui";
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type WorkerModel } from "./config.ts";
import type { AgentSummary } from "./protocol.ts";
import { workerSource, type HostSource } from "./source.ts";
import { ChatView, formatCost, statusRow } from "./ui.ts";

/** Screen-local selection and drafts only; all agent state comes from the host. */
export class AgentsApp implements Component, Focusable {
  private hasFocus = false;
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.updateFocus(); }
  private updateFocus() {
    this.editor.focused = this.hasFocus && (!!this.renaming || (!!this.form && this.form.step !== 3));
    if (this.view) this.view.focused = this.hasFocus && !this.form && !this.confirming;
  }
  private source: HostSource; private tui: TuiAltScreen; private theme: Theme;
  private life = new AbortController(); private agents: AgentSummary[] = [];
  private stack: string[] = [];
  private renaming?: { agent: AgentSummary; error?: string };
  private selected = 0; private view?: ChatView;
  private note = "Connecting…"; private editor: Editor;
  private form?: { step: number; name: string; cwd: string; model?: WorkerModel; choices: ModelChoice[]; error?: string };
  private picker?: SelectList;
  private dirPicker?: DirPicker;
  private confirming?: AgentSummary;
  private ticker?: ReturnType<typeof setInterval>;
  private frame = 0;
  private model?: WorkerModel;
  private exit: () => void;
  private removeInput: () => void;
  constructor(source: HostSource, tui: TuiAltScreen, theme: Theme, options: { agentModel?: WorkerModel; exit?: () => void } = {}) {
    this.source = source; this.tui = tui; this.theme = theme;
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.onSubmit = text => void (this.renaming ? this.rename(text) : this.advance(text));
    this.editor.onChange = text => {
      if (this.renaming) this.renaming.error = this.nameError(text.trim(), this.renaming.agent);
      else if (this.form?.step === 0) this.form.error = this.nameError(text.trim());
      else if (this.form?.step === 2) this.filterModels(text);
      else if (this.form) this.form.error = undefined;
    };
    this.model = options.agentModel; this.exit = options.exit ?? (() => {});
    this.removeInput = tui.addInputListener(data => {
      // Kitty's keyboard protocol (on in Ghostty/cmux) sends ctrl+c as an escape sequence, not \x03.
      if (!matchesKey(data, Key.ctrl("c"))) return;
      this.dispose(); tui.stop(); this.exit(); return { consume: true };
    });
    this.setScreen();
    void this.roster();
  }
  private async roster() {
    let delay = 250;
    while (!this.life.signal.aborted) {
      try {
        await this.source.roster(this.life.signal, rows => {
          this.agents = rows; this.view?.setChildren(this.rows().find(row => row.agent.id === this.stack.at(-1))?.agent.children ?? []); this.note = ""; delay = 250;
          const running = this.rows().some(row => row.agent.running);
          if (running && !this.ticker) this.ticker = setInterval(() => { this.frame++; this.tui.requestRender(); }, 100);
          if (!running && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
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
  private setScreen() {
    this.updateFocus();
    const list = { render: (width: number) => this.list(width), invalidate() {} };
    const root = this.form || this.confirming || this.renaming ? this : this.view?.layout ?? list;
    this.tui.setLayoutRoot(root);
  }
  private rows() {
    const out: { agent: AgentSummary; depth: number }[] = [];
    const visit = (agents: AgentSummary[], depth: number) => { for (const agent of agents) { out.push({ agent, depth }); visit(agent.children, depth + 1); } };
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
    const bound = agent.hosted ? workerSource(this.source, agent.id) : {
      page: async () => ({ entries: [{ id: 1, kind: "pi.assistant", model: [{ content: [{ type: "text", text: this.rows().find(row => row.agent.id === agent.id)?.agent.latest ?? "No published message. This Pi session has no hosted transcript." }] }] }] }),
      status: async () => this.rows().find(row => row.agent.id === agent.id)?.agent ?? agent,
      watch: (signal: AbortSignal, receive: () => void) => this.source.roster(signal, () => receive()),
    };
    this.view = new ChatView(this.tui, this.theme, agent.name, bound, this.life.signal, {
      send: (text, mode) => this.source.send(agent.id, text, mode), stop: () => this.source.stop(agent.id),
      back: () => {
        const child = this.stack.pop();
        const parent = this.rows().find(row => row.agent.id === this.stack.at(-1))?.agent;
        if (parent) { this.open(parent, false); if (child) this.view?.focusChild(child); }
        else { this.stack = []; this.view?.dispose(); this.view = undefined; this.setScreen(); }
        this.tui.requestRender();
      },
    }, () => this.note, { open: worker => {
      const child = this.rows().find(row => row.agent.id === worker.id)?.agent;
      if (child) this.open(child);
    } }); this.view.setChildren(agent.children); this.setScreen(); this.tui.requestRender();
  }
  private nameError(name: string, target?: AgentSummary) {
    const siblings = target ? this.rows().find(row => row.agent.children.some(child => child.id === target.id))?.agent.children ?? this.agents : this.agents;
    return agentNameError(name) ?? (siblings.some(agent => agent.hosted && agent.id !== target?.id && agent.name === name)
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
      this.formStep(3); this.tui.requestRender();
    };
  }
  private formStep(step: number) {
    const form = this.form; if (!form) return;
    form.step = step; form.error = undefined; this.picker = undefined; this.dirPicker = undefined;
    if (step === 1) this.dirPicker = new DirPicker({
      cwd: form.cwd || undefined,
      recent: this.rows().flatMap(({ agent }) => agent.cwd ? [agent.cwd] : []),
      height: () => Math.max(6, this.tui.terminal.rows - 4),
      onChoose: path => void this.advance(path), onCancel: () => this.formStep(0),
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
    }
    this.updateFocus();
  }
  private async advance(text: string) {
    const form = this.form; if (!form) return;
    if (form.step === 0) {
      form.error = this.nameError(text.trim());
      if (!form.error) { form.name = text.trim(); this.formStep(1); }
    } else if (form.step === 1) {
      form.cwd = text.trim();
      try {
        form.choices = await this.source.models(this.life.signal);
        if (this.form !== form || form.step !== 1) return;
        if (!form.choices.length) throw new Error("No models available; log in or configure models first");
        this.formStep(2);
      } catch (error) { if (this.form !== form || form.step !== 1) return; form.error = String(error); }
    } else if (form.step === 3) {
      form.model = { ...form.model!, thinking: text as WorkerModel["thinking"] };
      try {
        await this.source.newAgent({ name: form.name, cwd: form.cwd, model: form.model, thinking: form.model.thinking });
        this.form = undefined; this.setScreen(); this.note = "";
      } catch (error) { form.error = String(error); }
    }
    if (form.error) { const error = form.error; this.editor.setText(text); form.error = error; }
    this.tui.requestRender();
  }
  private list(width: number): string[] {
    const rows = this.rows(); this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const height = this.tui.terminal.rows;
    const hints = width >= 64 ? ["↑↓ select · enter/→ open · n new · r rename · x disable · q quit"]
      : ["↑↓ select · enter/→ open · n new", "r rename · x disable · q quit"];
    const capacity = Math.max(1, height - 4 - hints.length);
    const start = Math.max(0, this.selected - capacity + 1);
    const lines = [this.theme.fg("accent", this.theme.bold("pi-agents")), ""];
    const nameWidth = Math.min(24, Math.max(6, ...rows.map(({ agent, depth }) => 2 * depth + agent.name.length + (agent.hosted ? 0 : 5))));
    for (const [index, { agent: a, depth }] of rows.slice(start, start + capacity).entries()) {
      const display = { ...a, name: `${"  ".repeat(depth)}${a.name}${a.hosted ? "" : " (Pi)"}` };
      lines.push(statusRow(display, width, index + start === this.selected, Date.now(), this.theme, nameWidth, this.frame, a.hosted ? undefined : `${a.connected ? "connected" : "offline"}`, 60));
    }
    while (lines.length < height - 2 - hints.length) lines.push("");
    const total = formatCost(rows.reduce((sum, row) => sum + (row.agent.cost ?? 0), 0));
    lines.push(total ? `Total ${total}${rows.some(row => row.agent.subscription) ? " (sub)" : ""}` : "", this.note, ...hints);
    return lines.map(line => truncateToWidth(line, width));
  }
  render(width: number): string[] {
    if (this.renaming) return ["Rename agent · enter save · esc cancel", ...this.editor.render(width), this.renaming.error ?? ""].map(line => truncateToWidth(line, width));
    if (this.form) {
      const form = this.form;
      const breadcrumb = [form.step > 0 ? form.name : "", form.step > 1 ? form.cwd : "", form.step > 2 ? `${form.model!.provider}/${form.model!.modelId}` : ""].filter(Boolean).join(" › ");
      return ["New agent · esc back · esc on name cancels", breadcrumb, ["Name", "Working directory", "Model · type to filter · ↑↓ select · enter choose", "Thinking · ↑↓ select · enter create"][form.step]!,
        ...(form.step === 1 ? this.dirPicker!.render(width) : form.step < 3 ? this.editor.render(width) : []), ...(this.picker?.render(width) ?? []), form.error ? this.theme.fg("error", form.error) : ""].map(line => truncateToWidth(line, width));
    }
    if (this.confirming) return [`Disable ${this.confirming.name}? y / n`].map(line => truncateToWidth(line, width));
    return this.view ? this.view.render(width).map(line => truncateToWidth(line, width)) : this.list(width);
  }
  handleInput(data: string) {
    if (this.renaming) {
      if (matchesKey(data, Key.escape)) this.renaming = undefined;
      else this.editor.handleInput(data);
    }
    else if (this.form) {
      if (this.form.step === 1) this.dirPicker!.handleInput(data);
      else if (matchesKey(data, Key.escape)) {
        if (this.form.step === 0) this.form = undefined;
        else {
          this.formStep(this.form.step - 1);
        }
      } else if (this.picker && (this.form.step === 3 || matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter))) this.picker.handleInput(data);
      else this.editor.handleInput(data);
    }
    else if (this.confirming) { const target = this.confirming; this.confirming = undefined; if (data === "y") void this.source.disable(target.id).catch(error => this.fail(error)); }
    else if (this.view) this.view.handleInput(data);
    else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.rows().length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) { const row = this.rows()[this.selected]; if (row) this.open(row.agent); }
    else if (data === "r") {
      const agent = this.rows()[this.selected]?.agent;
      if (agent?.hosted) { this.renaming = { agent }; this.editor.setText(agent.name); }
      else this.note = "External Pi sessions cannot be renamed";
    }
    else if (data === "q") { this.dispose(); this.tui.stop(); this.exit(); return; }
    else if (data === "x") this.confirming = this.rows()[this.selected]?.agent;
    else if (data === "n") { this.form = { step: 0, name: "", cwd: "", model: this.model, choices: [] }; this.note = ""; this.formStep(0); }
    this.setScreen();
    this.tui.requestRender();
  }
  invalidate() { this.view?.invalidate(); this.editor.invalidate(); }
  dispose() { this.life.abort(); this.view?.dispose(); clearInterval(this.ticker); this.removeInput(); }
}
