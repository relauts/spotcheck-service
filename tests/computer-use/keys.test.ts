import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapGeminiKey, mapGeminiKeys, selectAllShortcut } from "../../src/computer-use/keys.js";

describe("keys", () => {
  it("maps Gemini key aliases to Playwright keys", () => {
    assert.equal(mapGeminiKey("Return"), "Enter");
    assert.equal(mapGeminiKey("esc"), "Escape");
    assert.equal(mapGeminiKey("ctrl"), "Control");
    assert.equal(mapGeminiKey("cmd"), "Meta");
    assert.equal(mapGeminiKey("a"), "a");
    assert.equal(mapGeminiKey("ArrowDown"), "ArrowDown");
  });

  it("maps a list of keys", () => {
    assert.deepEqual(mapGeminiKeys(["Control", "a"]), ["Control", "a"]);
  });

  it("rejects empty keys", () => {
    assert.throws(() => mapGeminiKey("  "), /non-empty/);
  });

  it("uses Meta on macOS and Control elsewhere", () => {
    assert.equal(selectAllShortcut("darwin"), "Meta+A");
    assert.equal(selectAllShortcut("linux"), "Control+A");
  });
});
