import assert from "node:assert/strict";
import { test } from "node:test";
import { agentNameError, suggestedAgentName } from "../src/agent-name.ts";

test("folder names yield valid, distinct, editable agent name suggestions", () => {
  assert.equal(suggestedAgentName("/work/my-project/", []), "my-project");
  assert.equal(suggestedAgentName("/work/My Project!", []), "My-Project-");
  assert.equal(suggestedAgentName("/work/.project", []), "project");
  assert.equal(suggestedAgentName("/work/project", ["project", "project-2"]), "project-3");
  for (const folder of ["/", "/work/main", "/work/human", "/work/constructor", "/work/🎉", `/work/${"x".repeat(100)}`]) {
    const first = suggestedAgentName(folder, []);
    const next = suggestedAgentName(folder, [first]);
    assert.equal(agentNameError(first), undefined);
    assert.equal(agentNameError(next), undefined);
    assert.notEqual(first, next);
    assert.ok(next.length <= 64);
  }
});
