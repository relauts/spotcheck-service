import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampNormalized, denormalize, denormalizeX, denormalizeY } from "../../src/computer-use/coords.js";

describe("coords", () => {
  it("clamps normalized values to 0-1000", () => {
    assert.equal(clampNormalized(-20), 0);
    assert.equal(clampNormalized(500), 500);
    assert.equal(clampNormalized(1000), 1000);
    assert.equal(clampNormalized(1500), 1000);
  });

  it("rejects non-finite coordinates", () => {
    assert.throws(() => clampNormalized(Number.NaN), /finite number/);
  });

  it("converts 0-1000 coordinates to pixels", () => {
    assert.equal(denormalizeX(0, 1024), 0);
    assert.equal(denormalizeY(1000, 768), 767);
    assert.equal(denormalize(500, 1000), 500);
    assert.equal(denormalize(999, 1024), Math.floor((999 / 1000) * 1024));
  });

  it("rejects invalid screen size", () => {
    assert.throws(() => denormalize(10, 0), /positive integer/);
  });
});
