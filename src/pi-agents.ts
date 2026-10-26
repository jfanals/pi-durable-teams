#!/usr/bin/env node
import { pair } from "./remote.ts";
import { stateDir } from "./paths.ts";
import { KeybindingsManager, ProcessTerminal, TUI_KEYBINDINGS, TuiAltScreen, setKeybindings } from "@earendil-works/pi-tui";
import { initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { piPresentation } from "./presentation.ts";
import { readConfig } from "./config.ts";
import { AgentsApp } from "./app.ts";
import { SocketHostSource } from "./source.ts";

if (process.argv[2] === "pair") {
  try { await pair(stateDir, process.argv.includes("--rotate")); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else {
const settings = SettingsManager.create(process.cwd());
initTheme(settings.getTheme(), false);
const { theme } = await piPresentation();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const source = new SocketHostSource();
await source.client.ensureHost();
const tui = new TuiAltScreen(new ProcessTerminal());
const app = new AgentsApp(source, tui, theme, { agentModel: (await readConfig()).agentModel, exit: () => process.exit(0) });
tui.addChild(app); tui.setFocus(app);
const close = () => { app.dispose(); tui.stop(); };
process.once("SIGINT", () => { close(); process.exit(0); });
process.once("SIGTERM", () => { close(); process.exit(0); });
tui.start();

}
