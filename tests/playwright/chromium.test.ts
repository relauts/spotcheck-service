import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../../src/shared/config.js";
import {
  closeBrowser,
  getChromiumLaunchOptions,
} from "../../src/playwright/chromium.js";

const config: AppConfig = {
  targetUrl: "https://example.com/",
  navigationTimeoutMs: 30_000,
  headless: true,
  chromiumSandbox: true,
  webPort: 3000,
  viewportWidth: 1024,
  viewportHeight: 768,
  geminiApiKey: undefined,
  geminiModel: "gemini-3.6-flash",
  geminiThinkingLevel: "minimal",
  geminiSeed: undefined,
  agentMaxTurns: 15,
};

describe("getChromiumLaunchOptions", () => {
  it("uses Playwright defaults without extra Chrome flags", () => {
    const options = getChromiumLaunchOptions(config);

    assert.equal(options.headless, true);
    assert.equal(options.chromiumSandbox, true);
    assert.equal(options.ignoreDefaultArgs, undefined);
    assert.equal(options.args, undefined);
  });
});

describe("closeBrowser", () => {
  it("does nothing when browser is missing", async () => {
    await assert.doesNotReject(() => closeBrowser(undefined));
  });
});
