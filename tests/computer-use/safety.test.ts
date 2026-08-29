import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmSafetyForWeb,
  isSafetyBlocked,
  readSafetyDecision,
  requiresSafetyConfirmation,
} from "../../src/computer-use/safety.js";

describe("safety", () => {
  it("reads safety_decision from function arguments", () => {
    const decision = readSafetyDecision({
      safety_decision: { decision: "require_confirmation", explanation: "Purchase" },
    });

    assert.deepEqual(decision, {
      decision: "require_confirmation",
      explanation: "Purchase",
    });
    assert.equal(requiresSafetyConfirmation(decision), true);
    assert.equal(isSafetyBlocked(decision), false);
  });

  it("detects blocked actions", () => {
    const decision = readSafetyDecision({
      safety_decision: { decision: "blocked" },
    });

    assert.equal(isSafetyBlocked(decision), true);
    assert.equal(requiresSafetyConfirmation(decision), false);
  });

  it("returns undefined when safety_decision is missing", () => {
    assert.equal(readSafetyDecision({ x: 1 }), undefined);
  });

  it("auto-approves safety confirmation for the web UI fallback", async () => {
    assert.equal(await confirmSafetyForWeb("Purchase", "click"), true);
  });
});
