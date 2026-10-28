import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { keepAwake } from "../src/awake.ts";
import type { AgentSummary } from "../src/protocol.ts";

const row = (id: string, running: boolean, children: AgentSummary[] = [], hosted = true): AgentSummary => ({ id, name: id, running, hosted, children });
const settle = () => new Promise(resolve => setTimeout(resolve, 1100));

test("keepAwake holds one assertion while any hosted agent or sub-agent runs", { timeout: 10000 }, async () => {
  let roster: AgentSummary[] = [row("lead", false), row("pi", true, [], false)];
  let listener = () => {};
  const holds: { killed: boolean }[] = [];
  const hold = () => {
    const child = Object.assign(new EventEmitter(), { killed: false });
    Object.assign(child, { kill: () => { child.killed = true; child.emit("exit"); return true; } });
    holds.push(child); return child as unknown as ChildProcess;
  };
  const awake = keepAwake({ agents: async () => roster, subscribe: l => { listener = l; return () => {}; } }, hold);
  await settle();
  assert.equal(holds.length, 0, "external agents do not keep the Mac awake");
  roster = [row("lead", false, [row("child", true)])]; listener(); listener();
  await settle();
  assert.equal(holds.length, 1); assert.equal(holds[0]!.killed, false);
  listener(); await settle();
  assert.equal(holds.length, 1, "still busy reuses the hold");
  roster = [row("lead", false, [row("child", false)])]; listener();
  await settle();
  assert.equal(holds[0]!.killed, true);
  roster = [row("lead", true)]; listener(); await settle();
  assert.equal(holds.length, 2);
  awake.close();
  assert.equal(holds[1]!.killed, true);
});
