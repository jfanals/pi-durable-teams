import { appScenario } from "../test/testing/app-scenario.ts";
const scenario = process.argv[2] ?? "narrow";
const sizes: Record<string, [number, number]> = { narrow: [100, 30], small: [60, 20], wide: [140, 30], "picker-small": [60, 20], "picker-wide": [140, 30] };
if (!sizes[scenario]) throw new Error("Scenario: narrow | small | wide | picker-small | picker-wide");
await appScenario(...sizes[scenario]!, (name, frame) => {
  if (!scenario.startsWith("picker-") || name === "form cwd") console.log(`\n--- ${scenario}: ${name} ---\n${frame}`);
});
