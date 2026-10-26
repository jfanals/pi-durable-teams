// Pi 1.4 exports initTheme and Theme, but NOT its live `theme` instance.
// Upstream export request: expose that instance so this single deep import can go away.
import type { Theme } from "@earendil-works/pi-coding-agent";
const themeModule = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;

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
