// Pi 1.4 exports initTheme and Theme, but NOT its live `theme` instance.
// Upstream export request: expose that instance so this single deep import can go away.
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
const piModule = (path: string) => new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const themeModule = piModule("./modes/interactive/theme/theme.js");

/** moduleUrl is overridable so the Pi-upgrade failure message can be tested. */
export async function piPresentation(moduleUrl = themeModule): Promise<{ theme: Theme }> {
  try {
    const colors = await import(moduleUrl);
    if (typeof colors.theme?.fg !== "function" || typeof colors.theme?.bg !== "function" || typeof colors.theme?.bold !== "function") throw new Error("Missing live theme instance; call initTheme first");
    return { theme: colors.theme };
  } catch (cause) {
    throw new Error(`Cannot load Pi's live theme from ${moduleUrl}. Pi may have changed its internal theme path; update src/presentation.ts or use a new public theme export.`, { cause });
  }
}

/** Pi's default "system" theme builds its backgrounds from the terminal's reported colours, which Pi
 * queries at startup. Do the same, or every message and tool background renders as terminal default. */
export async function syncTerminalColors(tui: TUI, themeName: string | undefined, moduleUrl = themeModule) {
  const colors = await import(moduleUrl);
  const apply = (reported: object) => {
    colors.setTerminalColors(reported);
    colors.setTheme(themeName ?? colors.SYSTEM_THEME_NAME);
    tui.invalidate(); tui.requestRender();
  };
  colors.markTerminalColorsPending();
  await tui.queryTerminalColors({ timeoutMs: 100, onLateReply: apply }).then(apply, () => apply({}));
}

// Pi's per-tool renderers (bash, read, edit, ...) are not in its public index either; same deep-import caveat.
let builtIn: Record<string, ToolRenderers> | undefined;
/** Loads once; until then tool calls render with Pi's generic layout. */
export async function loadToolRenderers() {
  if (builtIn) return builtIn;
  const renderers: Record<string, ToolRenderers> = (await import(piModule("./core/tools/renderers/index.js"))).createAllToolRenderers();
  // Pi's edit tool definition adds this; its renderer draws its own box.
  return builtIn = { ...renderers, edit: { ...renderers.edit, renderShell: "self" } };
}
export const builtInRenderers = (name: string): ToolRenderers | undefined => builtIn?.[name];

/** Pi's keybindings (ctrl+o, ctrl+t, the user's keybindings.json). Its manager is a type-only public export. */
export async function piKeybindings() {
  const { KeybindingsManager } = await import(piModule("./core/keybindings.js"));
  return KeybindingsManager.create();
}

type Usage = { input: number; cacheRead: number; cacheWrite: number; cost: { input: number; cacheRead: number; cacheWrite: number } };
type Message = { role: string; provider: string; model: string; timestamp: number; usage: Usage };
type Miss = { missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean };
/** Pi's cache-miss detection (core/cache-stats.js, not in its public index). Entries are Pi session entries. */
export async function piCacheMisses(): Promise<(entries: object[], models: { getModel(provider: string, id: string): any }) => Map<Message, Miss>> {
  return (await import(piModule("./core/cache-stats.js"))).collectCacheMisses;
}
/** Pi's wording and threshold for a transcript notice, or undefined below it. */
export function cacheMissText(miss: Miss, formatTokens: (n: number) => string) {
  if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return undefined;
  const label = miss.modelChanged ? "Cache miss after model switch"
    : miss.idleMs >= 5 * 60_000 ? `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle` : "Cache miss";
  return `${label}: ${formatTokens(miss.missedTokens)} tokens re-billed${miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : ""}`;
}

/** Pi's cache warmer (core/cache-warmer.js, not in its public index): the class and its transcript wording. */
export async function piCacheWarming(): Promise<{
  CacheWarmer: new (models: { streamSimple: Function }, session: { appendUsage: Function; getBranch(): object[] }, getMode: () => string) => {
    start(request: { model: object; context: object; options: object }, isCurrent: () => boolean): void;
    onAgentSettled(): void; cancel(): void; onWarmed?: (entry: object) => void;
  };
  formatCacheWarmingUsage(entry: { usage: { cost: { total: number } }; note?: string }): string;
}> {
  return import(piModule("./core/cache-warmer.js"));
}
