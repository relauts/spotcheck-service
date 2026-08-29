import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAllowedModel,
  loadModels,
  type ModelEntry,
} from "../../src/shared/models.js";

describe("loadModels", () => {
  it("loads entries from files/model.json", async () => {
    const models = await loadModels();
    assert.ok(models.length > 0);
    assert.equal(models[0]?.model, "gemini-3.5-flash-lite");
    assert.equal(models[0]?.cache_price_per_million, 0.03);
    assert.equal(models[0]?.output_price_per_million, 2.5);
  });
});

describe("assertAllowedModel", () => {
  const models: ModelEntry[] = [
    {
      provider: "GEMINI",
      model: "gemini-3.7-flash",
      input_price_per_million: 0.75,
      output_price_per_million: 3.75,
      cache_price_per_million: 0.075,
      description: "test",
    },
  ];

  it("returns the model when allowed", () => {
    assert.equal(assertAllowedModel("gemini-3.7-flash", models), "gemini-3.7-flash");
  });

  it("rejects unknown models", () => {
    assert.throws(() => assertAllowedModel("nope", models), /Unknown model: nope/);
  });
});
