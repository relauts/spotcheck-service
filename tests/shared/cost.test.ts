import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addUsage, computeCostUsd, EMPTY_USAGE, parseUsage } from "../../src/shared/cost.js";

const lite = {
  input_price_per_million: 0.3,
  output_price_per_million: 2.5,
  cache_price_per_million: 0.03,
};

describe("parseUsage", () => {
  it("reads Gemini usage fields and ignores raw_prompt_token", () => {
    assert.deepEqual(
      parseUsage({
        total_tokens: 46,
        total_input_tokens: 10,
        total_output_tokens: 36,
        total_cached_tokens: 0,
        total_thought_tokens: 0,
        total_tool_use_tokens: 0,
        raw_prompt_token: 4132,
      }),
      {
        inputTokens: 10,
        outputTokens: 36,
        thoughtTokens: 0,
        cachedTokens: 0,
      },
    );
  });

  it("returns empty usage for missing values", () => {
    assert.deepEqual(parseUsage(undefined), EMPTY_USAGE);
  });
});

describe("computeCostUsd", () => {
  it("bills the Gemini sample at Flash-Lite rates", () => {
    assert.equal(
      computeCostUsd({ inputTokens: 10, outputTokens: 36, thoughtTokens: 0, cachedTokens: 0 }, lite),
      0.000093,
    );
  });

  it("bills thought tokens as output", () => {
    assert.equal(
      computeCostUsd({ inputTokens: 0, outputTokens: 20, thoughtTokens: 22, cachedTokens: 0 }, lite),
      0.000105,
    );
  });

  it("bills cached tokens at the cache price", () => {
    assert.equal(
      computeCostUsd({ inputTokens: 100, outputTokens: 10, thoughtTokens: 5, cachedTokens: 40 }, lite),
      0.000057,
    );
  });
});

describe("addUsage", () => {
  it("sums every turn in a task", () => {
    const total = addUsage(
      { inputTokens: 10, outputTokens: 36, thoughtTokens: 0, cachedTokens: 0 },
      { inputTokens: 20, outputTokens: 4, thoughtTokens: 2, cachedTokens: 5 },
    );
    assert.deepEqual(total, {
      inputTokens: 30,
      outputTokens: 40,
      thoughtTokens: 2,
      cachedTokens: 5,
    });
    assert.equal(computeCostUsd(total, lite), 0.000113);
  });
});
