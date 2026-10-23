import assert from "node:assert/strict";
import { after as cleanup, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { openTeams } from "../src/teams.ts";
import { liveStatus, renderDelivery, renderTeamResult, renderTranscript, TeamPanel, WorkerView, type ViewResult, type WorkerStatus } from "../src/ui.ts";

initTheme("dark");
const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trimEnd());

test("cards, receipts and worker transcript are readable, bounded and truthful", async () => {
  // Card: sender first, model-only boilerplate hidden, bounded collapsed, complete expanded.
  const body = Array.from({ length: 30 }, (_, i) => `finding ${i + 1}`).join("\n\n");
  const message = { content: `[reader (7); request 9]\n${body}\n\nNo acknowledgement is needed.`,
    details: { id: "d1", from: { id: "7", teamId: "m", role: "worker", name: "reader" }, text: body, mode: "followUp", request: "9" } };
  const collapsed = plain(renderDelivery(message, { expanded: false, outputPad: 1 }, theme).render(60));
  assert.ok(collapsed.length <= 10, collapsed.join("\n"));
  assert.match(collapsed.join("\n"), /reader · our team/);
  assert.match(collapsed.join("\n"), /more lines/);
  assert.doesNotMatch(collapsed.join("\n"), /acknowledgement|request 9/);
  const expanded = plain(renderDelivery(message, { expanded: true, outputPad: 1 }, theme).render(60)).join("\n");
  assert.match(expanded, /finding 30/); assert.match(expanded, /request 9/);
  // A left click toggles the card in place, like Pi's built-in blocks.
  const card = renderDelivery(message, { expanded: false, outputPad: 1 }, theme);
  const click = { type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 60, height: 10, shift: false, alt: false, ctrl: false } as const;
  assert.ok(card.handleMouse?.(click));
  assert.match(plain(card.render(60)).join("\n"), /finding 30/);
  card.handleMouse?.(click);
  assert.doesNotMatch(plain(card.render(60)).join("\n"), /finding 30/);
  assert.equal(card.handleMouse?.({ ...click, button: "right" }), undefined);
  const legacy = plain(renderDelivery({ content: "legacy body" }, { expanded: true, outputPad: 1 }, theme).render(60)).join("\n");
  assert.match(legacy, /Team message[\s\S]*legacy body/);
  const malformed = plain(renderDelivery({ content: "raw text", details: { id: "x" } }, { expanded: true, outputPad: 1 }, theme).render(60)).join("\n");
  assert.match(malformed, /Team message[\s\S]*raw text/);

  // Tool receipts say accepted, not done; errors and unknown shapes keep the raw text.
  const send = plain(renderTeamResult({ content: [{ type: "text", text: "{}" }], details: { taskId: 12 } }, { expanded: false, isPartial: false }, theme,
    { args: { action: "send", target: "reader" }, isError: false }).render(80)).join("\n");
  assert.match(send, /accepted · request 12/); assert.doesNotMatch(send, /done|complete/);
  const failed = plain(renderTeamResult({ content: [{ type: "text", text: "Worker stopped" }] }, { expanded: false, isPartial: false }, theme,
    { args: { action: "send" }, isError: true }).render(80)).join("\n");
  assert.match(failed, /Worker stopped/);

  // Team panel: running workers one per line with activity, time and tokens; others only counted.
  const focus: unknown[] = []; const opened: WorkerStatus[] = [];
  const panelTui = { setFocus: (c: unknown) => focus.push(c), requestRender() {} } as unknown as TUI;
  const panel = new TeamPanel(panelTui, theme, w => opened.push(w));
  assert.deepEqual(panel.render(80), []);
  const now = Date.now();
  const reviewer = liveStatus({ id: "1", name: "reviewer", live: { run: {}, tools: [{ callId: "c1", name: "read", status: "running" }] },
    latest: { content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/ui.ts" } }] },
    usage: { models: { "x/y": { input: 40_000, output: 8_200, cacheRead: 99_999, cacheWrite: 0 } } }, since: now - 134_000,
    agent: { model: { provider: "claude-code", modelId: "claude-opus-5-5" }, thinkingLevel: "medium" } });
  panel.setWorkers([{ id: "2", name: "scout", enabled: true, since: now - 90_000, finishedAt: now - 30_000 }, reviewer, { id: "3", name: "old", enabled: false }]);
  const summary = plain(panel.render(80));
  assert.equal(summary.length, 3, summary.join("\n"));
  assert.match(summary[0]!, /reviewer +reading src\/ui\.ts +opus-5-5 medium · 2m 1[45]s · 48\.2k tok$/);
  assert.doesNotMatch(plain(panel.render(70))[0]!, /opus/); // model drops first on narrow terminals
  assert.match(summary[1]!, /scout +idle · last reply just now +1m 00s$/); // finished 30 s ago: still listed
  assert.match(summary[2]!, /^ +1 stopped · ↓ to select/);
  assert.ok(panel.render(30).every(line => visibleWidth(line) <= 30));
  // Down focuses it: every worker listed, running first; Up from the top returns to the prompt.
  const editor = { handleInput: (d: string) => focus.push(`typed ${d}`), render: () => [], invalidate() {} };
  panel.enter(editor); panel.focused = true;
  const open = plain(panel.render(80));
  assert.equal(open.length, 4); assert.match(open[0]!, /› .*reviewer/); assert.match(open[1]!, /scout +idle · last reply/); assert.match(open[2]!, /old +stopped/);
  panel.handleInput("\x1b[B"); panel.handleInput("\r");
  assert.equal(opened[0]?.name, "scout");
  panel.handleInput("\x1b[A"); panel.handleInput("\x1b[A");
  assert.equal(focus.at(-1), editor);
  panel.handleInput("x"); assert.equal(focus.at(-1), "typed x"); // typing goes back to the prompt
  // A minute after its last reply an idle worker leaves the list and is only counted.
  panel.focused = false;
  panel.setWorkers([reviewer, { id: "2", name: "scout", enabled: true, since: now - 150_000, finishedAt: now - 61_000 }]);
  assert.match(plain(panel.render(80)).at(-1)!, /1 idle · ↓ to select/);
  panel.setWorkers([]); panel.dispose();

  // Real Durable transcript: input attribution, paired tool call/error, assistant Markdown, no system noise.
  const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" }), fauxAssistantMessage("The file **is missing**.")]);
  const registry = createRegistry(); registry.install(CodingTools);
  const service = await openTeams(new MemoryStorage(), { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }) });
  try {
    const main = await service.register({ sessionId: "ui", secret: "x".repeat(36), cwd: process.cwd(), name: "Main", model: { provider: "faux", modelId: "faux-1" } });
    const spawned = await service.action(main, { action: "spawn", name: "reader", message: "Read missing.txt" }, "s") as any;
    await service.harness.waitForTask(spawned.taskId, BACKGROUND_CONTEXT);
    const page = await service.action(main, { action: "inspect", target: "reader", transcript: true }, "") as any;
    const lines = plain(renderTranscript(page.entries, "reader", 50, theme));
    const text = lines.join("\n");
    assert.ok(text.indexOf("Main → reader") < text.indexOf("▸ read missing.txt ✗"), text);
    assert.ok(text.indexOf("▸ read missing.txt ✗") < text.indexOf("The file is missing."), text);
    assert.doesNotMatch(text, /toolsAdded|harness|pi\.system/);

    // Worker view: fills the screen, fits the width, follows live until scrolled, never yanks a scrolled view.
    let rows = 8; const renders: number[] = [];
    const tui = { terminal: { get rows() { return rows; } }, requestRender: () => renders.push(1) } as unknown as TUI;
    let entries = [...page.entries];
    let result: ViewResult | undefined;
    const life = new AbortController();
    cleanup(() => life.abort()); // stops the view's clock even when an assertion fails
    const view = new WorkerView(tui, theme, "reader", {
      page: async () => ({ entries }),
      status: async () => ({ id: "1", name: "reader", enabled: true, running: true, since: Date.now() - 75_000, tokens: 12_300,
        model: "opus-5-5", thinking: "medium", context: 50_000, contextWindow: 200_000, cwd: "/srv/app" }),
      watch: signal => new Promise(resolve => signal.addEventListener("abort", () => resolve())),
    }, value => { result = value; }, life.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    const screen = plain(view.render(50));
    assert.equal(screen.length, rows);
    assert.ok(view.render(50).every(line => visibleWidth(line) <= 50));
    assert.match(screen[0]!, /reader · running · live/);
    assert.match(plain(view.render(100))[1]!, /^opus-5-5 medium · working 1m 1[56]s · 12\.3k tok · context 25% · \/srv\/app$/);
    assert.match(screen.join("\n"), /The file is missing\./); // follows the end
    view.handleInput("k"); view.handleInput("k");
    const before = plain(view.render(50)).slice(3, -2);
    entries = [...entries, { id: 10_000, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "late news" }] }] }];
    await (view as any).refresh();
    const after = plain(view.render(50));
    assert.deepEqual(after.slice(3, -2), before);
    assert.match(after.at(-1)!, /new activity/);
    view.handleInput("G");
    assert.match(plain(view.render(50)).join("\n"), /late news/);
    rows = 4; // tiny terminal: controls and status still fit (details line dropped), nothing is clipped
    const tiny = plain(view.render(50));
    assert.equal(tiny.length, 4); assert.match(tiny[0]!, /reader · running/); assert.match(tiny.at(-1)!, /esc back/);
    view.handleInput("s"); assert.deepEqual(result, { type: "send", mode: "steer" });
    life.abort();
  } finally { await service.close(); }
});
