import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/shared/config.js";
import { runApp } from "../../src/playwright/index.js";

describe("runApp", () => {
  it("opens example.com and clicks the a tag", async () => {
    const loadedUrl = await runApp(
      loadConfig({
        TARGET_URL: "https://example.com",
        HEADLESS: "true",
        CHROMIUM_SANDBOX: "true",
        NAVIGATION_TIMEOUT_MS: "30000",
        PORT: "3000",
      }),
    );

    assert.match(loadedUrl, /iana\.org/);
  });
});
