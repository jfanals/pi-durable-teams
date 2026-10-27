import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, visibleWidth, setKeybindings } from "@earendil-works/pi-tui";
import { AgentsApp } from "../../src/app.ts";
import { Client } from "../../src/client.ts";
import { startHost } from "../../src/host.ts";
import { piPresentation, piKeybindings } from "../../src/presentation.ts";
import { SocketHostSource } from "../../src/source.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

export async function appScenario(width: number, height: number, print?: (name: string, frame: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), "agents-app-"));
  execFileSync("git", ["init", "-b", "footer-test", directory], { stdio: "ignore" });
  const fake = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-opus-2", name: "Middle Fancy Model", reasoning: true }], tokensPerSecond: 1000 });
  fake.setResponses(Array.from({ length: 100 }, () => request => {
    const last = request.messages.findLast(message => message.role !== "system");
    const text = JSON.stringify(last);
    if (last?.role === "user" && text.includes("DELEGATE")) return fauxAssistantMessage(fauxToolCall("team", { action: "spawn", name: "reader", message: "Read and report" }), { stopReason: "toolUse" });
    if (last?.role === "user" && text.includes("SLOW")) return fauxAssistantMessage("Still working. ".repeat(10000));
    if (last?.role === "user" && text.includes("SCROLL")) return fauxAssistantMessage(Array.from({ length: 80 }, (_, i) => `Transcript line ${i + 1}`).join("\n\n"));
    return fauxAssistantMessage("Hello from the faux agent.");
  }));
  const models = createModels(); models.setProvider(fake.provider);
  const host = await startHost(directory, join(directory, "s"), { models, agentModel: async () => ({ provider: "faux", modelId: "faux-1" }) });
  const source = new SocketHostSource(new Client(join(directory, "s")));
  const terminal = new VirtualTerminal(width, height); const tui = new TuiAltScreen(terminal);
  setKeybindings(await piKeybindings(directory));
  initTheme("dark", false); const { theme } = await piPresentation();
  let exited = false;
  const app = new AgentsApp(source, tui, theme, { cwd: directory, exit: () => { exited = true; } });
  async function frame() { await terminal.waitForRender(); const lines = await terminal.flushAndGetViewport(); for (const columns of [40, width]) assert.ok(app.render(columns).every(line => visibleWidth(line) <= columns)); return lines.join("\n"); }
  async function wait(text: string) { for (let i = 0; i < 300; i++) { const screen = await frame(); if (screen.includes(text) && (text === "Loading settings…" || !screen.includes("Loading settings…"))) return screen; await delay(10); } throw new Error(`Missing ${text}\n${await frame()}`); }
  async function until(predicate: () => Promise<boolean>) { for (let i = 0; i < 300; i++) { if (await predicate()) return; await delay(10); } assert.fail("Timed out waiting for host state"); }
  async function key(data: string) { terminal.sendInput(data); await delay(50); }
  try {
    const alphaId = (await source.newAgent({ name: "alpha", cwd: directory })).id!; await source.newAgent({ name: "beta", cwd: tmpdir() });
    const alpha = async () => (await source.list()).find(agent => agent.id === alphaId);
    tui.addChild(app); tui.setFocus(app); tui.start();
    const list = await wait("beta"); assert.match(list, /alpha/); print?.("list", list);
    assert.ok(list.indexOf("beta") < list.indexOf("alpha"), "most recent agent first");
    assert.match(list, /0 running · 2 idle · total \$/);
    assert.match(list, /r rename.*x disable.*q quit/);
    await key("\x1b[B"); await key("\r"); await wait(`alpha · ${alphaId}`); // alpha is second: beta is newer.
    // Pi's slash list, Tab insertion, Escape dismissal, and cwd-relative @ paths.
    await key("/cl"); await wait("Clone this conversation");
    await key("\t"); assert.match(await frame(), /\/clone/);
    await key("\x15"); // Ctrl+U clears the completed command without submitting it.
    await key("/co"); await wait("Compact conversation context"); await key("\x1b");
    assert.doesNotMatch(await frame(), /Compact conversation context/);
    await key("\x15");
    await writeFile(join(directory, "completion-proof.txt"), "hello");
    await key("@completion-proof"); await wait("completion-proof.txt");
    await key("\t"); assert.match(await frame(), /@completion-proof\.txt/);
    await key("\x15");
    // The actual Pi external editor helper runs, then our TUI resumes with the edited draft.
    await mkdir(join(directory, ".pi"), { recursive: true });
    const editorScript = join(directory, "editor.cjs");
    await writeFile(editorScript, `require("node:fs").writeFileSync(process.argv[2], "external draft\\n");`);
    await writeFile(join(directory, ".pi", "settings.json"), JSON.stringify({ externalEditor: `${process.execPath} ${editorScript}` }));
    await key("initial draft"); await key("\x07"); await wait("external draft");
    await key("\x15");
    await key("Hello"); await key("\r"); const chat = await wait("Hello from the faux agent."); print?.("chat", chat);
    assert.doesNotMatch(chat, /pi-agents|beta/);
    assert.match(chat, /↑.*↓/);
    assert.match(chat, /faux-1/);
    assert.match(chat, /\(footer-test\) • alpha/);
    assert.match(chat, new RegExp(`alpha · ${alphaId} · ← back`));
    assert.doesNotMatch(chat, /↓ to select/);
    // The open chat reuses Pi's selector and keybindings; changes persist in host status.
    await key("\x0c"); await wait("configured providers");
    await key("opus"); await key("\r");
    await until(async () => (await alpha())?.modelId === "faux-opus-2");
    await wait("Model: faux-opus-2");
    await key("\x10");
    await until(async () => (await alpha())?.modelId === "faux-1");
    await key("\x1b[80;6u"); // Shift+Ctrl+P (Kitty)
    await until(async () => (await alpha())?.modelId === "faux-opus-2");
    const unscopedModels = source.models.bind(source);
    source.models = async signal => (await unscopedModels(signal)).map(model => ({ ...model, scoped: true, cycleThinking: "high" }));
    await key("\x10");
    await until(async () => (await alpha())?.modelId === "faux-1" && (await alpha())?.thinking === "high");
    await wait("Switched to faux-1 (thinking: high)");
    source.models = async signal => (await unscopedModels(signal)).map(model => ({ ...model, scoped: model.modelId === "faux-1" }));
    await key("\x10"); await wait("Only one model in scope");
    source.models = unscopedModels;
    await key("/model opus"); await key("\r"); await wait("configured providers");
    await key("\r"); await until(async () => (await alpha())?.modelId === "faux-opus-2");
    await key("/model faux/faux-1"); await key("\r");
    await until(async () => (await alpha())?.modelId === "faux-1");
    await key("/thinking low"); await key("\r");
    await until(async () => (await alpha())?.thinking === "low");
    await wait("Thinking level: low");
    await key("\x1b[Z");
    await until(async () => (await alpha())?.thinking === "medium");
    await wait("Thinking level: medium");
    await key("/thinking"); await key("\r"); await wait("Thinking Level");
    await key("high"); await key("\r");
    await until(async () => (await alpha())?.thinking === "high");
    await key("SLOW"); await key("\r");
    await until(async () => (await alpha())?.running === true);
    const working = await wait("(esc to stop)"); print?.("working", working);
    const workingIndex = working.split("\n").findIndex(line => line.includes("(esc to stop)"));
    assert.match(working.split("\n")[workingIndex + 1]!, /─/, "working line immediately above editor border");
    assert.match(working, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working · \d+s \(esc to stop\)/, "as Pi, the working line does not repeat the running tool");
    // Option+Enter (Kitty protocol, as Ghostty and cmux send it) queues a follow-up, shown above the editor at once.
    await key("LATER"); await key("\x1b[13;3u");
    print?.("follow-up", await wait("Follow-up: LATER"));
    await key("\x1b");
    await until(async () => (await alpha())?.running === false);
    await until(async () => !(await frame()).includes("(esc to stop)"));
    print?.("idle after stop", await frame());
    assert.equal((await alpha())?.enabled, true);
    await key("SCROLL"); await key("\r"); await wait("Transcript line 80");
    const bottom = await frame();
    await key("\x1b[5~"); const scrolled = await frame(); assert.notEqual(scrolled, bottom);
    await key("\x1b[6~"); assert.match(await frame(), /Transcript line 80/);
    await key(`\x1b[<64;${Math.min(width - 2, 70)};5M`);
    assert.notEqual(await frame(), bottom);
    await key("\x1b[6~");

    // Pi's /tree and idle double-Esc use Pi's own selector; selecting a user message restores its editor text.
    await key("/tree"); await key("\r"); await wait("Session Tree");
    await key("\x1b");
    await key("\x1b"); await key("\x1b"); await wait("Session Tree");
    await key("\x1b[A"); await key("\r");
    await until(async () => (await source.inputs(alphaId)).at(-1)?.text !== "SCROLL");
    assert.match(await frame(), /SCROLL/);
    await key("\r"); await wait("Transcript line 80");

    await key("\x1b[D"); await wait("n new");
    await key("n");
    const review = await wait("Review ·"); print?.("form review", review);
    assert.doesNotMatch(review, /Recent ·|choose current directory/);
    assert.match(review, new RegExp(basename(directory)));
    assert.match(review, /faux\/faux-1/);
    assert.match(review, /Thinking: medium/);
    assert.equal((await source.list()).length, 2, "review starts no agent");
    assert.notEqual((await source.list())[0]!.cwd, directory, "most recent agent is in a different folder");
    assert.ok(app.render(240).join("\n").includes(`Working folder: ${directory} · change`), "folder row previews the launch folder, not another agent's folder");
    await key("\x1b[B"); await key("\r"); await wait("Name ·");
    await key("\x15"); await key("main"); const invalid = await wait("Use a unique");
    await key("\r"); assert.match(await frame(), /Name/); print?.("form invalid name", invalid);
    await key("\x15"); await key("alpha"); await key("\r"); await wait("Name already exists");
    await key("\x15"); await key("gamma"); await key("\r"); await wait("Review ·");
    // Cancelling a folder edit preserves the review draft.
    await key("\x1b[B"); await key("\x1b[B"); await key("\r"); await wait("Working directory");
    await key("\x1b"); await wait("Review ·"); assert.match(await frame(), /Name: gamma/);
    // Choosing another folder keeps an explicitly edited name.
    await key("\x1b[B"); await key("\x1b[B"); await key("\r");
    await key("\x1b[D"); await key("\r"); await wait("Review ·");
    assert.match(await frame(), /Name: gamma/);
    await key("\x1b[B"); await key("\x1b[B"); await key("\r");
    await key(`\x1b[200~${directory}\x1b[201~`); await key("\r"); await wait("Review ·");
    // Optional model and thinking edits return to review, not immediate creation.
    for (let i = 0; i < 3; i++) await key("\x1b[B");
    await key("\r"); const picker = await wait("type to filter"); print?.("form model", picker);
    await key("\x1b"); await wait("Review ·");
    for (let i = 0; i < 3; i++) await key("\x1b[B");
    await key("\r");
    for (const char of "OpUs") await key(char);
    assert.match(await frame(), /faux\/faux-opus-2/);
    assert.doesNotMatch(await frame(), /faux\/faux-1/);
    await key("\x15");
    for (const char of "fancy") await key(char);
    assert.match(await frame(), /faux\/faux-opus-2/);
    assert.doesNotMatch(await frame(), /faux\/faux-1/);
    await key("\r"); await wait("Review ·");
    for (let i = 0; i < 4; i++) await key("\x1b[B");
    await key("\r"); const thinking = await wait("Thinking ·"); print?.("form thinking", thinking);
    await key("\x1b[B"); await key("\r"); await wait("Review ·");
    assert.equal((await source.list()).length, 2);
    await key("\r");
    const created = await wait("No messages yet"); print?.("created", created);
    assert.match(created, /gamma/);
    await key("first task"); await key("\r"); await wait("Hello from the faux agent.");
    await key("\x1b[D"); await wait("n new");
    const gamma = (await source.list()).find(agent => agent.name === "gamma");
    assert.ok(gamma); assert.equal(gamma.cwd, await realpath(directory)); assert.equal(gamma.model, "faux-opus-2"); assert.equal(gamma.thinking, "high");
    // A model fetch completing after cancellation must not resurrect the form.
    const fetchModels = source.models.bind(source);
    let releaseModels!: () => void;
    const modelGate = new Promise<void>(resolve => { releaseModels = resolve; });
    source.models = async signal => { await modelGate; return fetchModels(signal); };
    await key("n"); await wait("Loading settings…");
    await key("\x1b"); await wait("n new");
    releaseModels(); await delay(100);
    assert.doesNotMatch(await frame(), /Review ·|Model ·/);
    source.models = fetchModels;
    // One confirmation creates directly in the launch folder, without a picker.
    await key("n"); await wait("Review ·"); await key("\r"); await wait("No messages yet");
    const quick = (await source.list()).find(agent => agent.name === basename(directory));
    assert.ok(quick); assert.equal(quick.cwd, await realpath(directory));
    assert.equal(quick.model, "faux-1"); assert.equal(quick.thinking, "medium");
    await key("\x1b[D"); await wait("n new"); await source.remove(quick.id);
    await until(async () => (await source.list()).length === 3);
    // The short path uses the suggested name and displayed configured defaults.
    await key("n"); await wait("Review ·");
    await key("\x1b[B"); await key("\x1b[B"); await key("\r");
    await key("\x1b[D"); await key("\r"); await wait("Review ·");
    assert.ok((await frame()).includes(`Name: ${basename(dirname(await realpath(directory)))}`), "untouched name follows the folder");
    assert.ok(app.render(240).join("\n").includes(`Working folder: ${dirname(directory)} · change`), "folder preview follows the chosen directory");
    await key("\x1b[B"); await key("\x1b[B"); await key("\r");
    await key(`\x1b[200~${directory}\x1b[201~`); await key("\r"); await wait("Review ·");
    await key("\r"); await wait("No messages yet");
    const suggested = (await source.list()).find(agent => agent.name === basename(directory));
    assert.ok(suggested); assert.equal(suggested.model, "faux-1"); assert.equal(suggested.thinking, "medium");
    await key("\x1b[D"); await wait("n new");
    await source.remove(suggested.id);
    await until(async () => (await source.list()).length === 3);
    // Missing or unavailable defaults require an explicit model choice.
    const fetchDefaults = source.defaults.bind(source);
    for (const defaults of [null, { provider: "missing", modelId: "gone" }]) {
      source.defaults = async () => defaults;
      await key("n"); await wait("Review ·");
      await key("\r"); await wait("Choose a model before creating");
      assert.equal((await source.list()).length, 3);
      await key("\x1b"); await wait("n new");
    }
    source.defaults = fetchDefaults;
    const lead = (await alpha())!;
    await source.send(lead.id, "DELEGATE");
    await until(async () => (await alpha())!.children.length > 0);
    const identity = { sessionId: "external", secret: "s".repeat(36) };
    await source.client.call("register", { ...identity, name: "Pi main", cwd: directory, model: { provider: "faux", modelId: "faux-1" } });
    const roster = await wait("  reader");
    assert.doesNotMatch(roster, /Pi main|offline|\(Pi\)/);
    print?.("nested hosted agents", roster);
    await key("r"); await wait("Rename agent");
    await key("\x15"); await key("beta"); await key("\r"); await wait("Name already exists");
    assert.match(await frame(), /beta/);
    const renameAgent = source.rename.bind(source);
    source.rename = async () => { throw new Error("Rename failed"); };
    await key("\x15"); await key("renamed"); await key("\r");
    await wait("Rename failed"); assert.match(await frame(), /renamed/);
    source.rename = renameAgent;
    await key("\r");
    const renamed = await wait("renamed"); assert.equal((await alpha())!.name, "renamed"); print?.("renamed", renamed);
    await key("\r"); const collapsedTeam = await wait("1 idle");
    assert.match(collapsedTeam, /1 idle · 0 stopped · team \$0\.000 · ↓ to select/); print?.("team collapsed", collapsedTeam);
    const readerId = (await alpha())!.children[0]!.id;
    await source.send(readerId, "SLOW");
    const spinner = (screen: string) => screen.split("\n").find(line => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*reader/.test(line))?.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)?.[0];
    await until(async () => !!spinner(await frame()));
    const teamRunning = await frame(); print?.("team running", teamRunning);
    await until(async () => spinner(await frame()) !== spinner(teamRunning));
    await key("\x1b[D"); await wait("n new");
    const listRunning = await frame(); assert.ok(spinner(listRunning)); print?.("list running child", listRunning);
    await until(async () => spinner(await frame()) !== spinner(listRunning));
    await key("\r"); await wait("reader");
    await source.stop(readerId); await wait("1 idle");
    await key("\x1b[B"); const panel = await wait("enter open"); print?.("sub-agent panel", panel);
    await key("\x1b[A"); assert.doesNotMatch(await frame(), /enter open/);
    await key("\x1b[B"); await key("\x1b"); assert.doesNotMatch(await frame(), /enter open/);
    await key("\x1b[B"); await key("draft"); assert.match(await frame(), /draft/); await key("\x15");
    await key("\x1b[B"); await key("\r"); const childChat = await wait("reader ·");
    assert.doesNotMatch(childChat, /pi-agents|↓ to select|team \$/); print?.("sub-agent chat", childChat);
    await key("\x1b[D"); const parentChat = await wait("enter open"); assert.match(parentChat, /renamed/); print?.("back to parent panel", parentChat);
    await key("\x1b[D"); await wait("n new");
    await key("x"); await wait("Disable"); await key("y");
    for (let i = 0; i < 100 && (await alpha())?.enabled; i++) await delay(10);
    assert.equal((await alpha())?.enabled, false);
    await key("d"); await wait("Remove renamed and 1 sub-agent? y/n"); await key("n");
    assert.ok(await alpha());
    await key("d"); await wait("Remove renamed"); await key("y");
    await until(async () => !(await alpha()));
    assert.ok(!(await source.list()).some(agent => agent.id === readerId));
    // Ctrl+C is global, including the editor and modal confirmation screens. As in Pi, one press clears the prompt and
    // a second within 500 ms exits. Legacy \x03 and Kitty keyboard protocol ctrl+c (Ghostty, cmux) both count, and
    // Kitty's key-release report after a press is not a second press; q on the list exits at once.
    for (const [screen, exitKey] of [["list", "\x03"], ["chat", "\x03"], ["form", "\x03"], ["confirm", "\x03"], ["list", "\x1b[99;5u"], ["chat", "\x1b[99;5u"], ["list", "q"]] as const) {
      const term = new VirtualTerminal(width, height); const screenTui = new TuiAltScreen(term);
      let didExit = false;
      const screenApp = new AgentsApp(source, screenTui, theme, { exit: () => { didExit = true; } });
      try {
        screenTui.addChild(screenApp); screenTui.setFocus(screenApp); screenTui.start();
        await delay(100);
        if (screen !== "list") term.sendInput(screen === "chat" ? "\r" : screen === "form" ? "n" : "x");
        await delay(50);
        if (screen === "chat") { term.sendInput("draft"); await delay(20); }
        term.sendInput(exitKey); await delay(20);
        if (exitKey.startsWith("\x1b[")) { term.sendInput("\x1b[99;5:3u"); await delay(20); }
        if (exitKey !== "q") {
          assert.equal(didExit, false, `${screen} ${JSON.stringify(exitKey)} first press`);
          if (screen === "chat") assert.ok(!(await term.flushAndGetViewport()).join("\n").includes("draft"), "first ctrl+c clears the prompt");
          term.sendInput(exitKey); await delay(20);
        }
        assert.equal(didExit, true, `${screen} ${JSON.stringify(exitKey)}`);
      } finally { screenApp.dispose(); screenTui.stop(); }
    }
    await key("\x03"); assert.equal(exited, false); await key("\x03"); assert.equal(exited, true);
  } finally { app.dispose(); tui.stop(); await host.close(); await rm(directory, { recursive: true, force: true }); }
}
