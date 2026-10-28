#!/usr/bin/env node
import { pair } from "./remote.ts";
import { stateDir } from "./paths.ts";
import { ProcessTerminal, TuiAltScreen, setKeybindings } from "@earendil-works/pi-tui";
import { copyToClipboard, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { piKeybindings, piPresentation, syncTerminalColors } from "./presentation.ts";
import { AgentsApp } from "./app.ts";
import { SocketHostSource } from "./source.ts";

if (process.argv[2] === "pair") {
  try { await pair(stateDir, process.argv.includes("--rotate")); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else if (process.argv[2] === "restart-host") {
  try { await (await import("./restart.ts")).restartHost(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else {
const settings = SettingsManager.create(process.cwd());
initTheme(settings.getTheme(), false);
const { theme } = await piPresentation();
setKeybindings(await piKeybindings());
const source = new SocketHostSource();
await source.client.ensureHost();
// Pi's clipboard path, given the selection's markdown instead of the wrapped screen rows.
const tui = new TuiAltScreen(new ProcessTerminal(), undefined, undefined, {
  copySelection: async text => {
    try { await copyToClipboard(app.copyText(text)); return true; } catch (error) { return error instanceof Error ? error.message : String(error); }
  },
});
const app = new AgentsApp(source, tui, theme, { exit: () => process.exit(0), cmux: true, doubleEscapeAction: settings.getDoubleEscapeAction() });
tui.addChild(app); tui.setFocus(app);
const close = () => { app.dispose(); tui.stop(); };
process.once("SIGINT", () => { close(); process.exit(0); });
process.once("SIGTERM", () => { close(); process.exit(0); });
tui.start();
void syncTerminalColors(tui, settings.getTheme());

}
