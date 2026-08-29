import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactOldScreenshots,
  extractModelText,
  getFunctionCalls,
  isBrowserActionName,
} from "../../src/computer-use/history.js";
import { BROWSER_ACTION_NAMES } from "../../src/computer-use/types.js";

describe("history", () => {
  it("knows all 20 browser actions", () => {
    assert.equal(BROWSER_ACTION_NAMES.length, 20);
    assert.equal(isBrowserActionName("click"), true);
    assert.equal(isBrowserActionName("click_at"), false);
  });

  it("extracts function calls with ids", () => {
    const calls = getFunctionCalls([
      { type: "model_output", content: [{ type: "text", text: "hi" }] },
      { type: "function_call", id: "1", name: "click", arguments: { x: 1, y: 2 } },
      { type: "function_call", name: "missing-id" },
    ]);

    assert.deepEqual(calls, [
      { type: "function_call", id: "1", name: "click", arguments: { x: 1, y: 2 } },
    ]);
  });

  it("extracts model text", () => {
    assert.equal(
      extractModelText([
        {
          type: "model_output",
          content: [
            { type: "text", text: "Done." },
            { type: "text", text: "Price is 10." },
          ],
        },
      ]),
      "Done. Price is 10.",
    );
  });

  it("keeps the latest function_result image and the user screenshot", () => {
    const history = [
      {
        type: "user_input",
        content: [
          { type: "text", text: "task" },
          { type: "image", data: "start", mime_type: "image/webp" },
        ],
      },
      {
        type: "function_result",
        call_id: "1",
        name: "click",
        result: [
          { type: "text", text: "one" },
          { type: "image", data: "first", mime_type: "image/webp" },
        ],
      },
      { type: "function_call", id: "2", name: "type", arguments: {} },
      {
        type: "function_result",
        call_id: "2",
        name: "type",
        result: [
          { type: "text", text: "two" },
          { type: "image", data: "latest", mime_type: "image/webp" },
        ],
      },
    ];

    compactOldScreenshots(history);

    assert.deepEqual(history[0]?.content, [
      { type: "text", text: "task" },
      { type: "image", data: "start", mime_type: "image/webp" },
    ]);
    assert.deepEqual(history[1]?.result, [{ type: "text", text: "one" }]);
    assert.deepEqual(history[3]?.result, [
      { type: "text", text: "two" },
      { type: "image", data: "latest", mime_type: "image/webp" },
    ]);
  });

  it("keeps safety acknowledgement text when old screenshots are removed", () => {
    const history = [
      {
        type: "function_result",
        call_id: "1",
        name: "click",
        result: [
          { type: "text", text: "{\"url\":\"https://example.com/\",\"safety_acknowledgement\":\"true\"}" },
          { type: "image", data: "old", mime_type: "image/webp" },
        ],
      },
      {
        type: "function_result",
        call_id: "2",
        name: "wait",
        result: [
          { type: "text", text: "later" },
          { type: "image", data: "latest", mime_type: "image/webp" },
        ],
      },
    ];

    compactOldScreenshots(history);

    assert.deepEqual(history[0]?.result, [
      { type: "text", text: "{\"url\":\"https://example.com/\",\"safety_acknowledgement\":\"true\"}" },
    ]);
  });
});
