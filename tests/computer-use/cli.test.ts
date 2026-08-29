import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgentTask } from "../../src/computer-use/cli.js";

describe("parseAgentTask", () => {
  it("joins CLI args after the script path", () => {
    assert.equal(parseAgentTask(["node", "agent.js", "search", "for", "pricing"]), "search for pricing");
  });

  it("rejects an empty task", () => {
    assert.throws(() => parseAgentTask(["node", "agent.js"]), /Usage: npm run agent/);
  });
});
