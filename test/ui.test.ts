import { chatItems, type ChatItem } from "../src/chat.ts";
import { transcript } from "../src/web/render.ts";
import { markdownForSelection } from "../src/copy.ts";
import { liveStatus, type WorkerStatus } from "../src/status.ts";
import assert from "node:assert/strict";
import { after as cleanup, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
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

  // Team panel: running workers one per line with activity, time, context and cost; others only counted, with the team's cost.
  const focus: unknown[] = []; const opened: WorkerStatus[] = [];
  const panelTui = { setFocus: (c: unknown) => focus.push(c), requestRender() {} } as unknown as TUI;
  const panel = new TeamPanel(panelTui, theme, w => opened.push(w));
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
  panel.setWorkers([{ id: "2", name: "scout", enabled: true, since: now - 90_000, finishedAt: now - 30_000 }, reviewer, { id: "3", name: "old", enabled: false, cost: 1.5 }]);
  const summary = plain(panel.render(80));
  assert.equal(summary.length, 3, summary.join("\n"));
  assert.match(summary[0]!, /reviewer +reading src\/ui\.ts +opus-5-5 medium · 2m 1[45]s · 18\.8%\/1\.0M · \$9\.812$/);
  assert.doesNotMatch(plain(panel.render(70))[0]!, /opus/); // model drops first on narrow terminals, then the cost
  assert.doesNotMatch(plain(panel.render(69))[0]!, /\$/);
  assert.match(summary[1]!, /scout +idle · last reply just now +1m 00s$/); // finished 30 s ago: still listed
  assert.match(summary[2]!, /^ +1 stopped · team \$11\.312 \(sub\) · ↓ to select/); // stopped workers' cost counts too
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
  assert.match(plain(panel.render(80)).at(-1)!, /1 idle · team \$9\.812 \(sub\) · ↓ to select/);
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
    let entries = [...page.entries];
    let result: ViewResult | undefined;
    const life = new AbortController();
    cleanup(() => life.abort()); // stops the view's clock even when an assertion fails
    const view = new WorkerView(tui, theme, "reader", {
      images: async () => [],
      page: async () => ({ items: chatItems(entries) }),
      status: async () => ({ id: "1", name: "reader", enabled: true, running: true, since: Date.now() - 75_000, cost: 0.31,
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
