import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { piPresentation } from "../src/presentation.ts";
import { test } from "node:test";
import { appScenario } from "./testing/app-scenario.ts";
for (const [width, height] of [[100, 30], [60, 20], [140, 30]]) {
  test(`agents app real host ${width}×${height}`, { timeout: 60000 }, () => appScenario(width!, height!));
}

test("Pi live theme compatibility shim succeeds and explains missing upgrade paths", async () => {
  initTheme("dark", false);
  assert.equal(typeof (await piPresentation()).theme.fg, "function");
  await assert.rejects(piPresentation(new URL("./missing-pi-theme.js", import.meta.url).href), /Cannot load Pi.*live theme.*Pi may have changed.*presentation\.ts/);
});
