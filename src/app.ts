import { Editor, HStack, Key, matchesKey, truncateToWidth, type Component, type Focusable, type TuiAltScreen } from "@earendil-works/pi-tui";
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
    this.editor.focused = this.hasFocus && !!this.form;
    if (this.view) this.view.focused = this.hasFocus && !this.form && !this.confirming;
  }
  private source: HostSource; private tui: TuiAltScreen; private theme: Theme;
  private life = new AbortController(); private agents: AgentSummary[] = [];
  private selected = 0; private view?: ChatView;
  private note = "Connecting…"; private editor: Editor;
  private form?: { step: number; name: string; cwd: string; model?: WorkerModel };
  private confirming?: AgentSummary;
  private ticker?: ReturnType<typeof setInterval>;
  private frame = 0;
  private model?: WorkerModel;
  private exit: () => void;
  private removeInput: () => void;
  constructor(source: HostSource, tui: TuiAltScreen, theme: Theme, options: { agentModel?: WorkerModel; exit?: () => void } = {}) {
    this.source = source; this.tui = tui; this.theme = theme;
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.onSubmit = text => void this.advance(text);
    this.model = options.agentModel; this.exit = options.exit ?? (() => {});
    this.removeInput = tui.addInputListener(data => {
      if (data !== "\x03") return;
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
          this.agents = rows; this.note = ""; delay = 250;
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
    const root = this.form || this.confirming ? this : this.view
      ? new HStack([{ component: list, basis: 62, shrink: 0, visible: viewport => viewport.width >= 120 }, { component: this.view.layout, grow: 1, basis: 0 }], { gap: 2 }) : list;
    this.tui.setLayoutRoot(root);
  }
  private rows() {
    const out: { agent: AgentSummary; depth: number }[] = [];
    const visit = (agents: AgentSummary[], depth: number) => { for (const agent of agents) { out.push({ agent, depth }); visit(agent.children, depth + 1); } };
    visit(this.agents, 0); return out;
  }
  private fail(error: unknown) { this.note = String(error); this.tui.requestRender(); }
  private open(agent: AgentSummary) {
    this.view?.dispose();
    const bound = agent.hosted ? workerSource(this.source, agent.id) : {
      page: async () => ({ entries: [{ id: 1, kind: "pi.assistant", model: [{ content: [{ type: "text", text: this.rows().find(row => row.agent.id === agent.id)?.agent.latest ?? "No published message. This Pi session has no hosted transcript." }] }] }] }),
      status: async () => this.rows().find(row => row.agent.id === agent.id)?.agent ?? agent,
      watch: (signal: AbortSignal, receive: () => void) => this.source.roster(signal, () => receive()),
    };
    this.view = new ChatView(this.tui, this.theme, agent.name, bound, this.life.signal, {
      send: (text, mode) => this.source.send(agent.id, text, mode), stop: () => this.source.stop(agent.id),
      back: () => { this.view?.dispose(); this.view = undefined; this.setScreen(); this.tui.requestRender(); },
    }, () => this.note); this.setScreen(); this.tui.requestRender();
  }
  private async advance(text: string) {
    const form = this.form; if (!form) return;
    if (form.step === 0) { if (!text.trim()) return; form.name = text.trim(); this.editor.setText(form.cwd); }
    if (form.step === 1) { form.cwd = text.trim() || process.cwd(); this.editor.setText(form.model ? `${form.model.provider}/${form.model.modelId}` : ""); }
    if (form.step === 2) {
      const slash = text.indexOf("/"); if (slash < 1 || !text.slice(slash + 1).trim()) { this.note = "Choose provider/model-id"; this.tui.requestRender(); return; }
      form.model = { ...form.model, provider: text.slice(0, slash), modelId: text.slice(slash + 1) }; this.editor.setText(form.model.thinking ?? "off");
    }
    if (form.step === 3) {
      if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(text)) { this.note = "Thinking: off, minimal, low, medium, high, xhigh"; this.tui.requestRender(); return; }
      try { await this.source.newAgent({ name: form.name, cwd: form.cwd, model: form.model, thinking: text as WorkerModel["thinking"] }); this.form = undefined; this.setScreen(); this.note = ""; }
      catch (error) { this.fail(error); return; }
    } else form.step++;
    this.tui.requestRender();
  }
  private list(width: number): string[] {
    const rows = this.rows(); this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const height = this.tui.terminal.rows;
    const start = Math.max(0, this.selected - Math.max(1, height - 5) + 1);
    const lines = [this.theme.fg("accent", this.theme.bold("pi-agents")), ""];
    const nameWidth = Math.min(24, Math.max(6, ...rows.map(({ agent, depth }) => 2 * depth + agent.name.length + (agent.hosted ? 0 : 5))));
    for (const [index, { agent: a, depth }] of rows.slice(start, start + Math.max(1, height - 5)).entries()) {
      const display = { ...a, name: `${"  ".repeat(depth)}${a.name}${a.hosted ? "" : " (Pi)"}` };
      lines.push(statusRow(display, width, index + start === this.selected, Date.now(), this.theme, nameWidth, this.frame, a.hosted ? undefined : `${a.connected ? "connected" : "offline"}`, 60));
    }
    while (lines.length < height - 3) lines.push("");
    const total = formatCost(rows.reduce((sum, row) => sum + (row.agent.cost ?? 0), 0));
    lines.push(total ? `Total ${total}${rows.some(row => row.agent.subscription) ? " (sub)" : ""}` : "", this.note, "↑↓ select · enter/→ open · n new · x disable");
    return lines.map(line => truncateToWidth(line, width));
  }
  render(width: number): string[] {
    if (this.form) {
      return ["New agent · esc cancel", "", ["Name", "Working directory", "Model (provider/model-id)", "Thinking"][this.form.step]!, ...this.editor.render(width), this.note].map(line => truncateToWidth(line, width));
    }
    if (this.confirming) return [`Disable ${this.confirming.name}? y / n`].map(line => truncateToWidth(line, width));
    return this.view ? this.view.render(width).map(line => truncateToWidth(line, width)) : this.list(width);
  }
  handleInput(data: string) {
    if (this.form) { if (matchesKey(data, Key.escape)) this.form = undefined; else this.editor.handleInput(data); }
    else if (this.confirming) { const target = this.confirming; this.confirming = undefined; if (data === "y") void this.source.disable(target.id).catch(error => this.fail(error)); }
    else if (this.view) this.view.handleInput(data);
    else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.rows().length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) { const row = this.rows()[this.selected]; if (row) this.open(row.agent); }
    else if (data === "x") this.confirming = this.rows()[this.selected]?.agent;
    else if (data === "n") { this.form = { step: 0, name: "", cwd: process.cwd(), model: this.model }; this.note = ""; this.editor.setText(""); }
    this.setScreen();
    this.tui.requestRender();
  }
  invalidate() { this.view?.invalidate(); this.editor.invalidate(); }
  dispose() { this.life.abort(); this.view?.dispose(); clearInterval(this.ticker); this.removeInput(); }
}
