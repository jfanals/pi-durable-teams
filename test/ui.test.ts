import { chatItems, withReply, type Ask, type ChatItem, type TranscriptEntry } from "../src/chat.ts";
import { transcript } from "../src/web/render.ts";
import { markdownForSelection } from "../src/copy.ts";
import { liveStatus, type WorkerStatus } from "../src/status.ts";
import assert from "node:assert/strict";
import { after as cleanup, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { openTeams } from "../src/teams.ts";
import { loadToolRenderers } from "../src/presentation.ts";
import { renderDelivery, renderSent, renderTeamCall, renderTeamResult, renderTranscript, TeamPanel, WorkerView, type ViewResult } from "../src/ui.ts";

initTheme("dark"); await loadToolRenderers();
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
  // Incoming, sent and team prompts use the same excerpt and global expansion rule.
  const sent = { target: "reader", mode: "followUp" as const, text: body };
  for (const component of [renderSent(sent, false, theme), renderTeamCall({ action: "spawn", name: "reader", message: body, timeoutSeconds: 1800 }, theme, { expanded: false })]) {
    const text = plain(component.render(60)).join("\n");
    assert.match(text, /more lines · ctrl\+o to expand/);
    assert.doesNotMatch(text, /finding 30/);
  }
  assert.match(plain(renderSent(sent, true, theme).render(60)).join("\n"), /finding 30/);
  const call = plain(renderTeamCall({ action: "send", target: "reader", message: body, timeoutSeconds: 1800 }, theme, { expanded: true }).render(60)).join("\n");
  assert.match(call, /remind 30m/); assert.match(call, /finding 30/);
  // Tool image bytes are requested by result entry ID only when Pi's image setting is enabled.
  const imageItems: ChatItem[] = [
    { id: "1", kind: "reply", parts: [{ type: "tool", id: "read-image", name: "read", subject: "image.png", args: { path: "image.png" } }] },
    { id: "2", kind: "result", callId: "read-image", ok: true, content: [{ type: "image", mimeType: "image/png" }] },
  ];
  const requested: string[] = [];
  const images = (id: string) => { requested.push(id); return undefined; };
  renderTranscript(imageItems, "reader", 60, theme, { showImages: false, images });
  assert.deepEqual(requested, []);
  renderTranscript(imageItems, "reader", 60, theme, { showImages: true, images });
  assert.deepEqual(requested, ["2"]);
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

  // Team panel: running workers as two-line cards (name with model, time, context and cost; activity beneath); others only counted, with the team's cost.
  const focus: unknown[] = []; const opened: WorkerStatus[] = [];
  const panelTui = { setFocus: (c: unknown) => focus.push(c), requestRender() {} } as unknown as TUI;
  const answered: string[] = []; let asks: Ask[] = []; let draft = ""; let cursor = 0;
  const prompt = { render: () => [], invalidate() {} };
  // The selection is a tinted band; here the tint shows as a leading "›".
  const tinted = { ...theme, bg: (_: string, t: string) => `›${t}` } as unknown as Theme;
  const panel = new TeamPanel(panelTui, tinted, w => opened.push(w), { asks: { list: () => asks, draft: () => draft, cursorLine: () => cursor, answer: ask => answered.push(ask.title), pick: (ask, option) => { answered.push(`${ask.title}: ${option}`); draft = withReply(draft, ask, option); }, prompt } });
  assert.deepEqual(panel.render(80), []);
  const now = Date.now();
  const reviewer = liveStatus({ id: "1", name: "reviewer", live: { run: {}, tools: [{ callId: "c1", name: "read", status: "running" }] },
    latest: { content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/ui.ts" } }] },
    usage: { models: { "x/y": { input: 40_000, output: 8_200, cacheRead: 99_999, cacheWrite: 0, cost: { total: 9.8121 } } } }, since: now - 134_000,
    agent: { model: { provider: "claude-code", modelId: "claude-opus-5-5" }, thinkingLevel: "medium" }, contextWindow: 1_000_000, subscription: true });
  assert.deepEqual(reviewer.tokens, { input: 40_000, output: 8_200, cacheRead: 99_999, cacheWrite: 0 });
  assert.equal(reviewer.provider, "claude-code"); assert.equal(reviewer.modelId, "claude-opus-5-5");
  const totals = liveStatus({ id: "sum", name: "sum", usage: { models: {
    "a/b": { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    "c/d": { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
  } } });
  assert.deepEqual(totals.tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  reviewer.context = 188_364;
  panel.setWorkers([{ id: "2", name: "scout", since: now - 90_000, finishedAt: now - 30_000 }, reviewer, { id: "3", name: "old", cost: 1.5 }]);
  const summary = plain(panel.render(80));
  assert.equal(summary.length, 3, summary.join("\n"));
  assert.match(summary[0]!, /reviewer +opus-5-5 medium · 2m 1[45]s · 18\.8%\/1\.0M · \$9\.812$/);
  assert.match(summary[1]!, /^ +reading src\/ui\.ts$/);
  assert.doesNotMatch(plain(panel.render(70))[0]!, /opus/); // model drops first on narrow terminals, then the cost
  assert.doesNotMatch(plain(panel.render(69))[0]!, /\$/);
  assert.match(summary[2]!, /^ +2 idle · team \$11\.312 \(sub\) · ↓ to select/); // idle workers are counted, their cost too
  assert.ok(panel.render(30).every(line => visibleWidth(line) <= 30));
  // Down focuses it on the running workers, idle ones still folded; moving past them lists the idle ones.
  // Up from the top returns to the prompt.
  const editor = { handleInput: (d: string) => focus.push(`typed ${d}`), render: () => [], invalidate() {} };
  panel.enter(editor); panel.focused = true;
  const open = plain(panel.render(80));
  assert.equal(open.length, 4); assert.match(open[0]!, /› .*reviewer/); assert.match(open[2]!, /^ +2 idle/);
  panel.handleInput("\x1b[B");
  const idle = plain(panel.render(80));
  assert.equal(idle.length, 7); assert.match(idle[2]!, /› .*scout/); assert.match(idle[3]!, /› +idle · last reply/); assert.match(idle[4]!, /^ +○ old/);
  panel.handleInput("\r");
  assert.equal(opened[0]?.name, "scout");
  panel.handleInput("\x1b[A"); panel.handleInput("\x1b[A");
  assert.equal(focus.at(-1), editor);
  panel.handleInput("x"); assert.equal(focus.at(-1), "typed x"); // typing goes back to the prompt
  panel.focused = false;
  // Waiting on you: ask titles above the team; Down selects one and shows its full text; Enter returns to the prompt and answers it.
  asks = [{ title: "Pick a name", text: "Option one or option two? I recommend one because it is shorter and reads better in the list.", entry: "9" }];
  const glance = plain(panel.render(40));
  assert.match(glance[0]!, /^ +Pick a name$/); assert.doesNotMatch(glance.join("\n"), /Option one/);
  panel.enter(editor); panel.focused = true;
  const asked = plain(panel.render(40));
  assert.match(asked[0]!, /› Pick a name/); assert.match(asked.join(" "), /recommend one because it is shorter/); assert.match(asked.at(-1)!, /enter answer/);
  assert.ok(asked.every(line => visibleWidth(line) <= 40));
  panel.handleInput("\x1b[B"); assert.match(plain(panel.render(80))[1]!, /› .*reviewer/); // Down past the asks reaches the team
  panel.handleInput("\x1b[A"); panel.handleInput("\r");
  assert.deepEqual(answered, ["Pick a name"]); assert.equal(focus.at(-1), editor);
  panel.focused = false;
  // Many asks: five titles then "+N more"; ones already answered in the draft are dimmed, and Down starts on the first left.
  asks = Array.from({ length: 9 }, (_, i) => ({ title: `Ask ${i + 1}`, text: `Question ${i + 1}`, entry: String(10 + i) }));
  draft = "Re: Ask 1 — yes\nRe: ask 2 — no\n";
  const many = plain(panel.render(80)); const row = (title: string) => many.find(line => line.trim().startsWith(`${title} `) || line.trim() === title)!;
  assert.match(row("Ask 1"), /in draft/); assert.match(row("Ask 2"), /in draft/); assert.doesNotMatch(row("Ask 3"), /in draft/);
  assert.ok(!many.some(line => /Ask 6/.test(line))); assert.ok(many.some(line => /\+4 more/.test(line)));
  // The ask being answered (the Re: line at or above the cursor) shows its question in full, even beyond the first five.
  assert.ok(many.some(line => /Question 1/.test(line))); // cursor on line 0: answering Ask 1
  draft = "Re: Ask 1 — yes\nRe: Ask 8 — maybe\nbecause"; cursor = 2;
  const answering = plain(panel.render(80));
  assert.ok(answering.some(line => /Ask 8 · in draft/.test(line)) && answering.some(line => /Question 8/.test(line)));
  assert.ok(!answering.some(line => /Question 1/.test(line))); assert.match(answering.join("\n"), /\+3 more/);
  draft = "Re: Ask 1 — yes\nRe: ask 2 — no\n"; cursor = 2;
  panel.enter(editor); panel.focused = true;
  assert.match(plain(panel.render(80)).find(line => line.includes("›"))!, /› Ask 3/);
  for (let i = 0; i < 6; i++) panel.handleInput("\x1b[B"); // every ask is reachable, the list scrolls
  const last = plain(panel.render(80));
  assert.match(last.find(line => line.includes("›"))!, /› Ask 9/); assert.ok(last.some(line => /Question 9/.test(line)));
  assert.match(last.at(-1)!, /9\/9 · ↑↓ select · enter answer/);
  panel.handleInput("\x1b"); panel.focused = false;
  // Options: Down walks through them, Enter or a number puts one in the draft and selects the next ask left.
  asks = [{ title: "Scope", text: "Which?", entry: "30", options: ["Asks only", "Both"] }, { title: "Web", text: "Too?", entry: "31", options: ["Yes", "No"] }, { title: "Free", text: "Say", entry: "32" }];
  draft = ""; cursor = 0; answered.length = 0;
  panel.enter(editor); panel.focused = true;
  const choosing = plain(panel.render(80));
  assert.match(choosing.join("\n"), /1 +Asks only\n.*2 +Both/); assert.match(choosing.at(-1)!, /enter answer · 1-2 pick/);
  panel.handleInput("\x1b[B"); panel.handleInput("\x1b[B");
  assert.match(plain(panel.render(80)).find(line => line.includes("›"))!, /› +2 +Both/);
  panel.handleInput("\r");
  assert.equal(draft, "Re: Scope — Both"); assert.match(plain(panel.render(80)).find(line => line.includes("›"))!, /› Web/);
  panel.handleInput("1"); assert.equal(draft, "Re: Scope — Both\nRe: Web — Yes");
  assert.match(plain(panel.render(80)).find(line => line.includes("›"))!, /› Free/);
  panel.handleInput("\x1b[A"); panel.handleInput("\x1b[A"); panel.handleInput("2"); // Up lands on the last option above; a new pick replaces the old one
  assert.equal(draft, "Re: Scope — Both\nRe: Web — No"); assert.deepEqual(answered, ["Scope: Both", "Web: Yes", "Web: No"]);
  panel.handleInput("\r"); assert.deepEqual(answered.at(-1), "Free"); assert.equal(focus.at(-1), editor); // no options: Enter answers as before
  panel.focused = false;
  panel.setWorkers([]); asks = []; panel.dispose();

  // Real Durable transcript: input attribution, paired tool call/error, assistant Markdown, no system noise.
  const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
  fake.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" }), fauxAssistantMessage("The file **is missing**.")]);
  const registry = createRegistry(); registry.install(CodingTools);
  const service = await openTeams(new MemoryStorage(), { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }) });
  try {
    const main = await service.register({ sessionId: "ui", secret: "x".repeat(36), cwd: process.cwd(), name: "Main", model: { provider: "faux", modelId: "faux-1" } });
    const spawned = await service.action(main, { action: "spawn", name: "reader", message: "Read missing.txt" }, "s") as any;
    await service.harness.waitForTask(spawned.taskId, BACKGROUND_CONTEXT);
    const reader = (await service.team(main))[0]!;
    const page = { entries: (await (await service.harness.conversation(Number(reader.id) as ConversationId, BACKGROUND_CONTEXT))!.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)).items };
    const lines = plain(renderTranscript(chatItems(page.entries), "reader", 50, theme));
    const text = lines.join("\n");
    // Pi's read renderer: title and path, then the error inside the tool box.
    assert.ok(text.indexOf("Main → reader") < text.indexOf("read missing.txt"), text);
    assert.ok(text.indexOf("read missing.txt") < text.indexOf("ENOENT"), text);
    assert.ok(text.indexOf("ENOENT") < text.indexOf("The file is missing."), text);
    assert.doesNotMatch(text, /toolsAdded|harness|pi\.system/);

    // Worker view: fills the screen, fits the width, follows live until scrolled, never yanks a scrolled view.
    let rows = 8; const renders: number[] = [];
    const tui = { terminal: { get rows() { return rows; } }, requestRender: () => renders.push(1) } as unknown as TUI;
    let entries: TranscriptEntry[] = [...page.entries];
    let result: ViewResult | undefined;
    const life = new AbortController();
    cleanup(() => life.abort()); // stops the view's clock even when an assertion fails
    const view = new WorkerView(tui, theme, "reader", {
      images: async () => [],
      page: async () => ({ items: chatItems(entries) }),
      status: async () => ({ id: "1", name: "reader", running: true, since: Date.now() - 75_000, cost: 0.31,
        model: "opus-5-5", thinking: "medium", context: 50_000, contextWindow: 200_000, cwd: "/srv/app" }),
      watch: signal => new Promise(resolve => signal.addEventListener("abort", () => resolve())),
    }, value => { result = value; }, life.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    const screen = plain(view.render(50));
    assert.equal(screen.length, rows);
    assert.ok(view.render(50).every(line => visibleWidth(line) <= 50));
    assert.match(screen[0]!, /reader · running · live/);
    assert.match(plain(view.render(100))[1]!, /^opus-5-5 medium · working 1m 1[56]s · 25\.0%\/200k · \$0\.310 · \/srv\/app$/);
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

test("chat items are plain JSON with clean text, tool subjects, notices and complete turn totals", () => {
  const items = chatItems([
    { id: 1, kind: "pi.system", model: [{ content: "private setup" }] },
    { id: 2, kind: "teams.message", data: { from: { name: "\x1b[31mLead\x1b[0m" }, message: "Read\x00 this" }, model: [{ timestamp: 1000 }] },
    { id: 3, kind: "pi.assistant", model: [{ timestamp: 1100, stopReason: "toolUse", usage: { input: 10, output: 2, cacheRead: 99, cacheWrite: 3, cost: { total: 0.1 } }, content: [
      { type: "thinking", thinking: "\x1b]0;title\x07Reasoning" },
      { type: "toolCall", id: "call", name: "bash", arguments: { command: "\n ls -la\nignored" } },
    ] }] },
    { id: 4, kind: "pi.tool-result", model: [{ toolCallId: "call", isError: true, content: "<harness>[error] Not found</harness>" }] },
    { id: 5, kind: "pi.assistant", model: [{ timestamp: 2500, stopReason: "stop", usage: { input: 20, output: 4, cacheRead: 99, cost: { total: 0.2 } }, content: [{ type: "text", text: "\x1bPprivate\x1b\\Done\x07" }] }] },
    { id: 6, kind: "pi.compaction", model: [{ content: [{ type: "text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nShip it\n</summary>" }] }] }, { id: 7, kind: "pi.reset" }, { id: 8, kind: "other.event" },
  ]);
  assert.deepEqual(items[0], { id: "2", kind: "input", from: "Lead", text: "Read this", at: 1000 });
  const call = items[1]; assert.ok(call?.kind === "reply");
  assert.deepEqual(call.parts, [{ type: "thinking", text: "Reasoning" }, { type: "tool", id: "call", name: "bash", subject: "ls -la", args: { command: "\n ls -la\nignored" } }]); assert.equal(call.turn, undefined);
  assert.deepEqual(items[2], { id: "4", kind: "result", callId: "call", ok: false, error: "Not found", content: [{ type: "text", text: "[error] Not found" }] });
  const answer = items[3]; assert.ok(answer?.kind === "reply");
  assert.deepEqual(answer.parts, [{ type: "text", text: "Done" }]); assert.equal(answer.turn?.ms, 1500); assert.equal(answer.turn?.tokens, 39);
  assert.ok(Math.abs(answer.turn!.cost - 0.3) < 1e-10);
  // Pi's compaction message: the summary itself, sized by the last reply's context (20 + 4 + 99).
  assert.deepEqual(items[4], { id: "6", kind: "compaction", summary: "## Goal\nShip it", tokensBefore: 123 });
  const compaction = (expanded: boolean) => renderTranscript([items[4]!], "w", 80, theme, { expanded }).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(compaction(false), /\[compaction\][\s\S]*Compacted from 123 tokens \(.* to expand\)/); assert.doesNotMatch(compaction(false), /Ship it/);
  assert.match(compaction(true), /Compacted from 123 tokens[\s\S]*Goal[\s\S]*Ship it/);
  assert.match(transcript([items[4]!]), /<details class="compaction"[^>]*>\n<summary>\[compaction\] Compacted from 123 tokens<\/summary>[\s\S]*<h2>Goal<\/h2>/);
  assert.deepEqual(items.slice(5).map(item => item.kind === "notice" && item.text), ["— context reset —", "[other.event]"]);
  assert.doesNotMatch(JSON.stringify(items), /private|\\u001b|\\u0000|\\u0007/);
  const inputs = chatItems([
    { id: 20, kind: "teams.report", data: { message: "**Report**" }, model: [{ content: "[Reader]: wrong" }] },
    { id: 21, kind: "teams.report", model: [{ content: "[Reader]: old report" }] },
    { id: 22, kind: "teams.message", model: [{ content: "[Lead]: old message" }] },
    { id: 23, kind: "pi.user", model: [{ content: "[Human]: keep prefix" }] },
  ]);
  assert.deepEqual(inputs.map(item => item.kind === "input" && item.text),
    ["**Report**", "old report", "old message", "[Human]: keep prefix"]);

});


test("reply parts render in original thinking, text, tool, text order", () => {
  const items = chatItems([{ id: 1, kind: "pi.assistant", model: [{ content: [
    { type: "thinking", thinking: "First reasoning" },
    { type: "text", text: "Before tool" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } },
    { type: "text", text: "After tool" },
  ] }] }]);
  const reply = items[0]; assert.ok(reply?.kind === "reply");
  assert.deepEqual(reply.parts.map(part => part.type), ["thinking", "text", "tool", "text"]);
  const rendered = plain(renderTranscript(items, "worker", 80, theme, { showThinking: true })).join("\n");
  const offsets = ["First reasoning", "Before tool", "$ pwd", "After tool"].map(text => rendered.indexOf(text));
  assert.ok(offsets.every((offset, i) => offset >= 0 && (i === 0 || offset > offsets[i - 1]!)), rendered);
});

test("a request crossing a page boundary retains its full turn stamp", () => {
  const entries = [
    { id: 1, kind: "pi.user", model: [{ timestamp: 1000, content: "Input" }] },
    { id: 2, kind: "pi.assistant", model: [{ timestamp: 1500, stopReason: "toolUse", usage: { input: 10, output: 2, cost: { total: 0.1 } } }] },
    { id: 3, kind: "pi.tool-result" },
    { id: 4, kind: "pi.assistant", model: [{ timestamp: 2500, stopReason: "stop", usage: { input: 20, output: 3, cost: { total: 0.2 } } }] },
  ];
  const full = chatItems(entries);
  const page = chatItems(entries.slice(2), entries.slice(0, 2));
  assert.deepEqual(page, full.filter(item => Number(item.id) >= 3));
  const reply = page.at(-1); assert.ok(reply?.kind === "reply");
  assert.deepEqual(reply.turn, { ms: 1500, tokens: 35, cost: 0.1 + 0.2 });
});

test("copying a terminal selection copies the markdown behind it, not the wrapped screen rows", () => {
  initTheme("dark", false);
  const code = "const answer = computeSomethingVeryLong(argumentNumberOne, argumentNumberTwo, three);";
  const source = `Here is a paragraph that wraps across several lines in a narrow terminal.\n\n\`\`\`ts\n${code}\nif (answer) console.log(answer);\n\`\`\`\n\n- item one with **bold** text\n- item \`two\`\n\n| a | b |\n|---|---|\n| 1 | 2 |`;
  const rows = new Markdown(source, 1, 0, getMarkdownTheme()).render(40).map(line => stripTerminalSequences(line).trimEnd());
  const select = (from: string, to: string) => {
    const a = rows.findIndex(row => row.includes(from)), b = rows.findLastIndex(row => row.includes(to));
    return rows.slice(a, b + 1).join("\n");
  };
  const copy = (text: string) => markdownForSelection(text, ["An older message: answer", source]);
  // Whole blocks come back as written: fences, list markers, emphasis, backticks and table pipes.
  assert.equal(copy(select("```ts", "```")), "```ts\n" + code + "\nif (answer) console.log(answer);\n```");
  assert.equal(copy(select("item one", "item two")), "- item one with **bold** text\n- item `two`");
  assert.equal(copy(select("│ a", "│ 1")), "| a | b |\n|---|---|\n| 1 | 2 |");
  // A wrapped paragraph loses the wrap breaks; a few words inside one row copy as they are.
  assert.equal(copy(select("Here is", "terminal.")), "Here is a paragraph that wraps across several lines in a narrow terminal.");
  assert.equal(copy("several lines"), "several lines");
  // No single message holds it (a tool box, or across messages): the screen text as selected.
  assert.equal(copy("╭─ bash ─╮\n│ ls -la │"), "╭─ bash ─╮\n│ ls -la │");
});

test("chat scrolls back page by page to the first message, keeping the view in place", async () => {
  const { TuiAltScreen, setKeybindings } = await import("@earendil-works/pi-tui");
  const { VirtualTerminal } = await import("./testing/virtual-terminal.ts");
  const { piKeybindings } = await import("../src/presentation.ts");
  const { ChatView } = await import("../src/ui.ts");
  setKeybindings(await piKeybindings());
  const all: ChatItem[] = Array.from({ length: 120 }, (_, i) => ({ id: String(i + 1), kind: "input", from: "human", text: `Message ${i + 1}`, at: 0 }));
  const cursors: string[] = [];
  // Newest 40 first, like the host; the cursor is the oldest id already loaded.
  const page = async (cursor?: string) => {
    if (cursor) cursors.push(cursor);
    const end = cursor ? Number(cursor) - 1 : all.length;
    const start = Math.max(0, end - 40);
    return { conversationId: "c", items: all.slice(start, end), ...(start ? { next: String(start + 1) } : {}) };
  };
  const terminal = new VirtualTerminal(60, 20); const tui = new TuiAltScreen(terminal);
  const life = new AbortController(); cleanup(() => life.abort());
  const view = new ChatView(tui, theme, "reader", {
    images: async () => [], page, status: async () => ({ id: "1", name: "reader", enabled: true }),
    watch: signal => new Promise(resolve => signal.addEventListener("abort", () => resolve())),
  }, life.signal, { send: async () => undefined, stop: async () => undefined, back() {} });
  tui.setLayoutRoot(view.layout); tui.setFocus(view); tui.start();
  const screen = async () => { await terminal.waitForRender(); return (await terminal.flushAndGetViewport()).join("\n"); };
  const until = async (ok: (text: string) => boolean) => {
    for (let i = 0; i < 200; i++) { const text = await screen(); if (ok(text)) return text; await new Promise(r => setTimeout(r, 10)); }
    assert.fail(`Timed out:\n${await screen()}`);
  };
  const toTop = async (pages: number) => {
    terminal.sendInput("\x1b[1;5H"); // ctrl+home: Pi's scroll to top
    await until(() => cursors.length === pages);
    await new Promise(r => setTimeout(r, 30));
    return screen();
  };
  try {
    await until(text => text.includes("Message 120"));
    // Reaching the top loads the page before; the lines that were at the top stay on screen.
    const first = await toTop(1); assert.match(first, /Message 81\b/); assert.doesNotMatch(first, /Message 60\b/);
    const second = await toTop(2); assert.match(second, /Message 41\b/); assert.doesNotMatch(second, /Message 20\b/);
    terminal.sendInput("\x1b[1;5H");
    await until(text => /Message 1\b/.test(text));
    assert.deepEqual(cursors, ["81", "41"], "one page per arrival at the top, none past the first message");
  } finally { tui.stop(); life.abort(); }
});

test("mouse: a selection in the prompt stays in the prompt and copies its text; a click toggles one tool block", async () => {
  const { TuiAltScreen, HStack, setKeybindings } = await import("@earendil-works/pi-tui");
  const { VirtualTerminal } = await import("./testing/virtual-terminal.ts");
  const { piKeybindings } = await import("../src/presentation.ts");
  const { ChatView } = await import("../src/ui.ts");
  setKeybindings(await piKeybindings());
  const items: ChatItem[] = [
    { id: "1", kind: "reply", parts: [{ type: "tool", id: "c1", name: "bash", subject: "seq a", args: { command: "seq a" } }, { type: "tool", id: "c2", name: "bash", subject: "seq b", args: { command: "seq b" } }] },
    ...["c1", "c2"].map((callId, i) => ({ id: String(2 + i), kind: "result" as const, callId, ok: true, content: [{ type: "text" as const, text: Array.from({ length: 30 }, (_, n) => `${callId} line ${n + 1}`).join("\n") }] })),
  ];
  const copied: string[] = [];
  const terminal = new VirtualTerminal(70, 60);
  const tui = new TuiAltScreen(terminal, undefined, undefined, { copySelection: async text => { copied.push(view.copyText(text)); return true; } });
  const life = new AbortController(); cleanup(() => life.abort());
  const view: InstanceType<typeof ChatView> & { copyText?: any } = new ChatView(tui, theme, "reader", {
    images: async () => [], page: async () => ({ conversationId: "c", items }), status: async () => ({ id: "1", name: "reader", enabled: true }),
    watch: signal => new Promise(resolve => signal.addEventListener("abort", () => resolve())),
  }, life.signal, { send: async () => undefined, stop: async () => undefined, back() {} });
  const { markdownForSelection } = await import("../src/copy.ts");
  view.copyText = (text: string) => markdownForSelection(text, view.markdown());
  const rail = { render: () => Array.from({ length: 60 }, () => "RAIL rail"), invalidate() {} };
  tui.setLayoutRoot(new HStack([{ component: rail, basis: 10, grow: 0, shrink: 0 }, { component: view.layout, basis: 0, grow: 1 }], { gap: 1 }));
  tui.setFocus(view); tui.start();
  const screen = async () => { await terminal.waitForRender(); return terminal.flushAndGetViewport(); };
  const until = async (ok: (lines: string[]) => boolean) => {
    for (let i = 0; i < 200; i++) { const lines = await screen(); if (ok(lines)) return lines; await new Promise(r => setTimeout(r, 10)); }
    assert.fail(`Timed out:\n${(await screen()).join("\n")}`);
  };
  const mouse = (code: number, x: number, y: number, release = false) => terminal.sendInput(`\x1b[<${code};${x + 1};${y + 1}${release ? "m" : "M"}`);
  try {
    view.setDraft("first line of the prompt\nsecond line");
    const shown = await until(lines => lines.some(line => line.includes("second line")) && lines.some(line => line.includes("c2 line 30")));
    const count = (lines: string[], text: string) => lines.filter(line => line.includes(text)).length;
    const collapsed = count(shown, "c1 line");
    // A click on the first tool block expands it alone; a second click folds it again.
    const c1 = shown.findIndex(line => line.includes("c1 line 30"));
    mouse(0, 20, c1); mouse(0, 20, c1, true);
    const open = await until(lines => count(lines, "c1 line") > collapsed);
    assert.equal(count(open, "c1 line"), 30); assert.equal(count(open, "c2 line"), collapsed, "the other block stays folded");
    const again = open.findIndex(line => line.includes("c1 line 30"));
    mouse(0, 20, again); mouse(0, 20, again, true);
    await until(lines => count(lines, "c1 line") === collapsed);
    // Dragging from the prompt's first line to below it selects the prompt's lines only, and copies its text.
    const lines = await screen();
    const first = lines.findIndex(line => line.includes("first line of the prompt"));
    mouse(0, lines[first]!.indexOf("first"), first); mouse(32, 5, first + 1); mouse(32, 60, first + 2); mouse(0, 60, first + 2, true);
    await until(() => copied.length > 0);
    assert.equal(copied[0], "first line of the prompt\nsecond line");
  } finally { tui.stop(); life.abort(); }
});

test("dashboard: a click on an agent's card opens it, on the full-page list too", async () => {
  const { TuiAltScreen, setKeybindings } = await import("@earendil-works/pi-tui");
  const { VirtualTerminal } = await import("./testing/virtual-terminal.ts");
  const { piKeybindings } = await import("../src/presentation.ts");
  const { AgentsApp } = await import("../src/app.ts");
  setKeybindings(await piKeybindings());
  const agents = [{ id: "1", name: "alpha", hosted: true, children: [] }, { id: "2", name: "beta", hosted: true, children: [] }] as any[];
  const opened: string[] = [];
  const source = new Proxy({
    roster: (signal: AbortSignal, receive: (rows: any[]) => void) => { receive(agents); return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve())); },
    page: async (target: string) => { opened.push(target); return { conversationId: target, items: [] }; },
    status: async (target: string) => agents.find(agent => agent.id === target),
    watch: (_: string, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve())),
  } as any, { get: (target, key) => target[key] ?? (async () => []) });
  const terminal = new VirtualTerminal(60, 20); const tui = new TuiAltScreen(terminal);
  const app = new AgentsApp(source, tui, theme, { cwd: process.cwd() });
  tui.addChild(app); tui.setFocus(app); tui.start();
  const screen = async () => { await terminal.waitForRender(); return terminal.flushAndGetViewport(); };
  try {
    let lines: string[] = [];
    for (let i = 0; i < 200 && !(lines = await screen()).some(line => line.includes("beta")); i++) await new Promise(r => setTimeout(r, 10));
    const row = lines.findIndex(line => line.includes("beta"));
    terminal.sendInput(`\x1b[<0;5;${row + 1}M`); terminal.sendInput(`\x1b[<0;5;${row + 1}m`);
    for (let i = 0; i < 200 && !opened.includes("2"); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(opened.includes("2") && !opened.includes("1"), `opened ${opened}`);
  } finally { app.dispose(); tui.stop(); }
});
