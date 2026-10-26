import { appScenario } from "../test/testing/app-scenario.ts";
const scenario = process.argv[2] ?? "narrow";
const sizes: Record<string, [number, number]> = { narrow: [100, 30], small: [60, 20], wide: [140, 30] };
if (!sizes[scenario]) throw new Error("Scenario: narrow | small | wide");
await appScenario(...sizes[scenario]!, (name, frame) => console.log(`\n--- ${scenario}: ${name} ---\n${frame}`));
