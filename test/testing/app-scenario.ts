import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsApp } from "../../src/app.ts";
import { Client } from "../../src/client.ts";
import { startHost } from "../../src/host.ts";
import { piPresentation } from "../../src/presentation.ts";
import { SocketHostSource } from "../../src/source.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

export async function appScenario(width: number, height: number, print?: (name: string, frame: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), "agents-app-"));
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
  initTheme("dark", false); const { theme } = await piPresentation();
  let exited = false;
  const app = new AgentsApp(source, tui, theme, { agentModel: { provider: "faux", modelId: "faux-1" }, exit: () => { exited = true; } });
  async function frame() { await terminal.waitForRender(); const lines = await terminal.flushAndGetViewport(); assert.ok(app.render(width).every(line => visibleWidth(line) <= width)); return lines.join("\n"); }
  async function wait(text: string) { for (let i = 0; i < 300; i++) { const screen = await frame(); if (screen.includes(text)) return screen; await delay(10); } throw new Error(`Missing ${text}\n${await frame()}`); }
  async function until(predicate: () => Promise<boolean>) { for (let i = 0; i < 300; i++) { if (await predicate()) return; await delay(10); } assert.fail("Timed out waiting for host state"); }
  async function key(data: string) { terminal.sendInput(data); await delay(50); }
  try {
    const alphaId = (await source.newAgent({ name: "alpha", cwd: directory })).id!; await source.newAgent({ name: "beta", cwd: directory });
    const alpha = async () => (await source.list()).find(agent => agent.id === alphaId);
    tui.addChild(app); tui.setFocus(app); tui.start();
    const list = await wait("beta"); assert.match(list, /alpha/); print?.("list", list);
    assert.ok(list.indexOf("beta") < list.indexOf("alpha"), "most recent agent first");
    assert.match(list, /r rename.*x disable.*q quit/);
    await key("\x1b[B"); await key("\r"); await wait("enter send"); // alpha is second: beta is newer.
    await key("Hello"); await key("\r"); const chat = await wait("Hello from the faux agent."); print?.("chat", chat);
    assert.doesNotMatch(chat, /pi-agents|beta/);
    await key("SLOW"); await key("\r");
    await until(async () => (await alpha())?.running === true);
    await key("\x1b");
    await until(async () => (await alpha())?.running === false);
    assert.equal((await alpha())?.enabled, true);
    await key("SCROLL"); await key("\r"); await wait("Transcript line 80");
    const bottom = await frame();
    await key("\x1b[5~"); const scrolled = await frame(); assert.notEqual(scrolled, bottom);
    await key("\x1b[6~"); assert.match(await frame(), /Transcript line 80/);
    await key(`\x1b[<64;${Math.min(width - 2, 70)};5M`);
    assert.notEqual(await frame(), bottom);
    await key("\x1b[6~");

    await key("\x1b[D"); await wait("n new");
    await key("n"); await wait("New agent");
    await key("main"); const invalid = await wait("Use a unique");
    await key("\r"); assert.match(await frame(), /Name/); assert.match(await frame(), /main/); print?.("form invalid name", invalid);
    await key("\x15"); await key("alpha"); await key("\r"); await wait("Name already exists");
    assert.match(await frame(), /alpha/);
    await key("\x15"); await key("gamma"); await key("\r");
    const cwd = await wait("Working directory"); print?.("form cwd", cwd);
    await key("\x1b"); await wait("Name"); await key("\r");
    assert.match(await frame(), /Recent/);
    await key("\r"); // First recent is alpha/beta's working directory.
    const picker = await wait("type to filter"); print?.("form model", picker);
    await key("\x1b"); await wait("Working directory");
    assert.ok((await frame()).includes(basename(directory)), "back from model starts at chosen cwd");
    await key("\r"); await wait("Model ·");
    for (const char of "OpUs") await key(char);
    assert.match(await frame(), /faux\/faux-opus-2/);
    assert.doesNotMatch(await frame(), /faux\/faux-1/);
    await key("\x15");
    for (const char of "fancy") await key(char);
    assert.match(await frame(), /faux\/faux-opus-2/);
    assert.doesNotMatch(await frame(), /faux\/faux-1/);
    await key("\x15"); await key("\x1b[B"); await key("\r");
    const thinking = await wait("Thinking ·"); print?.("form thinking", thinking);
    await key("\x1b[B"); await key("\r");
    const created = await wait("No messages yet"); print?.("created", created);
    assert.match(created, /gamma/);
    await key("first task"); await key("\r"); await wait("Hello from the faux agent.");
    await key("\x1b[D"); await wait("n new");
    const gamma = (await source.list()).find(agent => agent.name === "gamma");
    assert.ok(gamma); assert.equal(gamma.cwd, await realpath(directory)); assert.equal(gamma.model, "faux-opus-2"); assert.equal(gamma.thinking, "high");
    // A model fetch completing after Esc must not advance the name screen.
    const fetchModels = source.models.bind(source);
    let releaseModels!: () => void;
    const modelGate = new Promise<void>(resolve => { releaseModels = resolve; });
    source.models = async signal => { await modelGate; return fetchModels(signal); };
    await key("n"); await key("race"); await key("\r"); await wait("Working directory");
    await key("\r"); await key("\x1b"); await wait("Name");
    releaseModels(); await delay(100);
    assert.match(await frame(), /Name/); assert.doesNotMatch(await frame(), /Model ·/);
    source.models = fetchModels;
    await key("\x1b"); await wait("n new");
    const lead = (await alpha())!;
    await source.send(lead.id, "DELEGATE");
    await until(async () => (await alpha())!.children.length > 0);
    const identity = { sessionId: "external", secret: "s".repeat(36) };
    await source.client.call("register", { ...identity, name: "Pi main", cwd: directory, model: { provider: "faux", modelId: "faux-1" } });
    const roster = await wait("Pi main (Pi)"); assert.match(roster, /  reader/); assert.doesNotMatch(roster, /Pi · (connected|offline)/);
    print?.("nested and Pi", roster);
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
    await key("\r"); await wait("1 idle");
    await key("\x1b[B"); const panel = await wait("enter open"); print?.("sub-agent panel", panel);
    await key("\x1b[A"); assert.doesNotMatch(await frame(), /enter open/);
    await key("\x1b[B"); await key("\x1b"); assert.doesNotMatch(await frame(), /enter open/);
    await key("\x1b[B"); await key("draft"); assert.match(await frame(), /draft/); await key("\x15");
    await key("\x1b[B"); await key("\r"); const childChat = await wait("reader ·");
    assert.doesNotMatch(childChat, /pi-agents|↓ to select/); print?.("sub-agent chat", childChat);
    await key("\x1b[D"); const parentChat = await wait("enter open"); assert.match(parentChat, /renamed/); print?.("back to parent panel", parentChat);
    await key("\x1b[D"); await wait("n new");
    await key("x"); await wait("Disable"); await key("y");
    for (let i = 0; i < 100 && (await alpha())?.enabled; i++) await delay(10);
    assert.equal((await alpha())?.enabled, false);
    // Raw Ctrl+C is global, including the editor and modal confirmation screens.
    // Legacy \x03, Kitty keyboard protocol ctrl+c (Ghostty, cmux), and q on the list all exit.
    for (const [screen, exitKey] of [["list", "\x03"], ["chat", "\x03"], ["form", "\x03"], ["confirm", "\x03"], ["list", "\x1b[99;5u"], ["chat", "\x1b[99;5u"], ["list", "q"]] as const) {
      const term = new VirtualTerminal(width, height); const screenTui = new TuiAltScreen(term);
      let didExit = false;
      const screenApp = new AgentsApp(source, screenTui, theme, { exit: () => { didExit = true; } });
      try {
        screenTui.addChild(screenApp); screenTui.setFocus(screenApp); screenTui.start();
        await delay(100);
        if (screen !== "list") term.sendInput(screen === "chat" ? "\r" : screen === "form" ? "n" : "x");
        await delay(50); term.sendInput(exitKey); await delay(20);
        assert.equal(didExit, true, `${screen} ${JSON.stringify(exitKey)}`);
      } finally { screenApp.dispose(); screenTui.stop(); }
    }
    await key("\x03"); assert.equal(exited, true);
  } finally { app.dispose(); tui.stop(); await host.close(); await rm(directory, { recursive: true, force: true }); }
}
