import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractBearerToken, isAuthorized, tokensEqual } from "../../src/api/auth.js";

describe("auth", () => {
  it("extracts a bearer token", () => {
    assert.equal(extractBearerToken("Bearer secret-token"), "secret-token");
    assert.equal(extractBearerToken("bearer secret-token"), "secret-token");
    assert.equal(extractBearerToken("Basic secret-token"), undefined);
    assert.equal(extractBearerToken(undefined), undefined);
  });

  it("compares tokens with hashed constant-time equality", () => {
    assert.equal(tokensEqual("same-token", "same-token"), true);
    assert.equal(tokensEqual("same-token", "other-token"), false);
    assert.equal(tokensEqual("short", "much-longer-token"), false);
  });

  it("authorizes only matching bearer tokens", () => {
    assert.equal(isAuthorized("Bearer good", "good"), true);
    assert.equal(isAuthorized("Bearer bad", "good"), false);
    assert.equal(isAuthorized(undefined, "good"), false);
  });
});
