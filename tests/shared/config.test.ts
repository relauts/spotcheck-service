import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CONFIG_FILE_NAME,
  DEFAULT_SERVICE_PORT,
  GEMINI_SAFETY_POLICIES,
  loadConfig,
  readConfigFile,
  readGeminiApiKeyFromConfigFile,
  requireApiToken,
  requireGeminiApiKey,
  resolveConfigFilePath,
  setGeminiApiKey,
  writeGeminiApiKeyToConfigFile,
} from "../../src/shared/config.js";

describe("loadConfig", () => {
  it("uses production defaults", () => {
    const config = loadConfig({});

    assert.equal(config.targetUrl, "https://example.com/");
    assert.equal(config.navigationTimeoutMs, 30_000);
    assert.equal(config.headless, true);
    assert.equal(config.chromiumSandbox, true);
    assert.equal(config.webPort, DEFAULT_SERVICE_PORT);
    assert.equal(config.viewportWidth, 1024);
    assert.equal(config.viewportHeight, 768);
    assert.equal(config.geminiApiKey, undefined);
    assert.equal(config.geminiModel, "gemini-3.6-flash");
    assert.equal(config.geminiThinkingLevel, "minimal");
    assert.equal(config.geminiSeed, undefined);
    assert.equal(config.agentMaxTurns, 15);
    assert.deepEqual(config.geminiDisabledSafetyPolicies, GEMINI_SAFETY_POLICIES);
    assert.equal(config.apiToken, undefined);
    assert.deepEqual(config.corsOrigins, []);
    assert.equal(config.savedDir, path.resolve(process.cwd(), "saved"));
    assert.equal(config.processedDir, path.resolve(process.cwd(), "processed"));
    assert.equal(config.historyDir, path.resolve(process.cwd(), "history"));
    assert.equal(config.maxSavedRuns, 2);
    assert.equal(config.installationId, undefined);
    assert.equal(config.telemetryUrl, undefined);
  });

  it("reads env overrides", () => {
    const config = loadConfig({
      TARGET_URL: "https://example.org/path",
      NAVIGATION_TIMEOUT_MS: "15000",
      HEADLESS: "false",
      CHROMIUM_SANDBOX: "false",
      PORT: "8080",
      VIEWPORT_WIDTH: "1280",
      VIEWPORT_HEIGHT: "720",
      GEMINI_API_KEY: " test-key ",
      GEMINI_MODEL: "gemini-3.5-flash",
      GEMINI_THINKING_LEVEL: " HIGH ",
      SEED: "42",
      AGENT_MAX_TURNS: "15",
      GEMINI_DISABLED_SAFETY_POLICIES: " Financial_Transactions , account_creation ",
      API_TOKEN: " secret-token ",
      CORS_ORIGINS: " http://127.0.0.1:18733 , http://localhost:18733 ",
      SAVED_DIR: "custom-saved",
      PROCESSED_DIR: "custom-processed",
      HISTORY_DIR: "custom-history",
      MAX_SAVED_RUNS: "4",
      INSTALLATION_ID: " 7d3cefb5-5ba9-43c3-af0c-2a1593c9f8b8 ",
      TELEMETRY_URL: " https://spotcheck-telemetry.example/v1/automation ",
    });

    assert.equal(config.targetUrl, "https://example.org/path");
    assert.equal(config.navigationTimeoutMs, 15_000);
    assert.equal(config.headless, false);
    assert.equal(config.chromiumSandbox, false);
    assert.equal(config.webPort, 8080);
    assert.equal(config.viewportWidth, 1280);
    assert.equal(config.viewportHeight, 720);
    assert.equal(config.geminiApiKey, "test-key");
    assert.equal(config.geminiModel, "gemini-3.5-flash");
    assert.equal(config.geminiThinkingLevel, "high");
    assert.equal(config.geminiSeed, 42);
    assert.equal(config.agentMaxTurns, 15);
    assert.deepEqual(config.geminiDisabledSafetyPolicies, [
      "financial_transactions",
      "account_creation",
    ]);
    assert.equal(config.apiToken, "secret-token");
    assert.deepEqual(config.corsOrigins, [
      "http://127.0.0.1:18733",
      "http://localhost:18733",
    ]);
    assert.equal(config.savedDir, path.resolve(process.cwd(), "custom-saved"));
    assert.equal(config.processedDir, path.resolve(process.cwd(), "custom-processed"));
    assert.equal(config.historyDir, path.resolve(process.cwd(), "custom-history"));
    assert.equal(config.maxSavedRuns, 4);
    assert.equal(config.installationId, "7d3cefb5-5ba9-43c3-af0c-2a1593c9f8b8");
    assert.equal(config.telemetryUrl, "https://spotcheck-telemetry.example/v1/automation");
  });

  it("resolves PROCESSED_DIR relative to the working directory", () => {
    const config = loadConfig({
      PROCESSED_DIR: "../relauts-spotcheck-processed/screenshot",
    });

    assert.equal(
      config.processedDir,
      path.resolve(process.cwd(), "../relauts-spotcheck-processed/screenshot"),
    );
  });

  it("resolves HISTORY_DIR relative to the working directory", () => {
    const config = loadConfig({
      HISTORY_DIR: "../relauts-spotcheck-processed/history",
    });

    assert.equal(
      config.historyDir,
      path.resolve(process.cwd(), "../relauts-spotcheck-processed/history"),
    );
  });

  it("keeps every safety policy active when set to none", () => {
    const config = loadConfig({ GEMINI_DISABLED_SAFETY_POLICIES: " NONE " });

    assert.deepEqual(config.geminiDisabledSafetyPolicies, []);
  });

  it("rejects an unknown safety policy", () => {
    assert.throws(
      () => loadConfig({ GEMINI_DISABLED_SAFETY_POLICIES: "financial_transactions,shopping" }),
      /Invalid safety policy: "shopping"/,
    );
  });

  it("rejects invalid url protocol", () => {
    assert.throws(() => loadConfig({ TARGET_URL: "ftp://example.com" }), /http or https/);
  });

  it("rejects invalid timeout", () => {
    assert.throws(() => loadConfig({ NAVIGATION_TIMEOUT_MS: "0" }), /positive integer/);
  });

  it("rejects invalid MAX_SAVED_RUNS", () => {
    assert.throws(() => loadConfig({ MAX_SAVED_RUNS: "0" }), /positive integer/);
    assert.throws(() => loadConfig({ MAX_SAVED_RUNS: "-1" }), /positive integer/);
    assert.throws(() => loadConfig({ MAX_SAVED_RUNS: "abc" }), /positive integer/);
  });

  it("rejects invalid boolean", () => {
    assert.throws(() => loadConfig({ HEADLESS: "yes" }), /Invalid boolean/);
  });

  it("rejects invalid thinking level", () => {
    assert.throws(() => loadConfig({ GEMINI_THINKING_LEVEL: "max" }), /Invalid thinking level/);
  });

  it("rejects invalid seed", () => {
    assert.throws(() => loadConfig({ SEED: "abc" }), /Invalid seed/);
  });

  it("rejects invalid telemetry url protocol", () => {
    assert.throws(() => loadConfig({ telemetryUrl: "ftp://example.com/v1/automation" }), /http or https/);
  });

  it("treats blank telemetry fields as unset", () => {
    const config = loadConfig({ installationId: "  ", telemetryUrl: "  " });
    assert.equal(config.installationId, undefined);
    assert.equal(config.telemetryUrl, undefined);
  });

  it("requires a Gemini API key for the agent", () => {
    const config = loadConfig({});
    assert.throws(() => requireGeminiApiKey(config), /GEMINI_API_KEY is required/);
    assert.equal(requireGeminiApiKey(loadConfig({ GEMINI_API_KEY: "abc" })), "abc");
  });

  it("requires an API token for the service", () => {
    const config = loadConfig({});
    assert.throws(() => requireApiToken(config), /API_TOKEN is required/);
    assert.equal(requireApiToken(loadConfig({ API_TOKEN: "tok" })), "tok");
  });

  it("reads camelCase JSON values and native types", () => {
    const config = loadConfig({
      targetUrl: "https://example.org/path",
      navigationTimeoutMs: 15000,
      headless: false,
      chromiumSandbox: false,
      port: 8080,
      viewportWidth: 1280,
      viewportHeight: 720,
      geminiApiKey: " test-key ",
      geminiModel: "gemini-3.5-flash",
      geminiThinkingLevel: " HIGH ",
      seed: 42,
      agentMaxTurns: 15,
      geminiDisabledSafetyPolicies: ["financial_transactions", "account_creation"],
      apiToken: " secret-token ",
      corsOrigins: ["http://127.0.0.1:18733", "http://localhost:18733"],
      savedDir: "custom-saved",
      processedDir: "custom-processed",
      historyDir: "custom-history",
      maxSavedRuns: 4,
      installationId: " 7d3cefb5-5ba9-43c3-af0c-2a1593c9f8b8 ",
      telemetryUrl: " https://spotcheck-telemetry.example/v1/automation ",
    });

    assert.equal(config.targetUrl, "https://example.org/path");
    assert.equal(config.navigationTimeoutMs, 15_000);
    assert.equal(config.headless, false);
    assert.equal(config.webPort, 8080);
    assert.equal(config.geminiApiKey, "test-key");
    assert.equal(config.geminiThinkingLevel, "high");
    assert.equal(config.geminiSeed, 42);
    assert.deepEqual(config.geminiDisabledSafetyPolicies, [
      "financial_transactions",
      "account_creation",
    ]);
    assert.deepEqual(config.corsOrigins, [
      "http://127.0.0.1:18733",
      "http://localhost:18733",
    ]);
    assert.equal(config.maxSavedRuns, 4);
    assert.equal(config.installationId, "7d3cefb5-5ba9-43c3-af0c-2a1593c9f8b8");
    assert.equal(config.telemetryUrl, "https://spotcheck-telemetry.example/v1/automation");
  });

  it("prefers a config file in the working directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotcheck-cwd-config-"));
    const filePath = path.join(dir, CONFIG_FILE_NAME);
    fs.writeFileSync(filePath, "{}");
    const previousCwd = process.cwd();

    try {
      process.chdir(dir);
      assert.equal(resolveConfigFilePath(), path.resolve(process.cwd(), CONFIG_FILE_NAME));
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("resolves the sibling config file path", () => {
    const configPath = resolveConfigFilePath();
    assert.equal(path.basename(configPath), CONFIG_FILE_NAME);
    assert.equal(path.dirname(configPath), path.resolve(process.cwd(), ".."));
  });

  it("reads a JSON config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotcheck-config-"));
    const filePath = path.join(dir, CONFIG_FILE_NAME);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        port: 9,
        apiToken: "file-token",
        corsOrigins: ["http://127.0.0.1:18733"],
      }),
    );

    const config = loadConfig(readConfigFile(filePath));
    assert.equal(config.webPort, 9);
    assert.equal(config.apiToken, "file-token");
    assert.deepEqual(config.corsOrigins, ["http://127.0.0.1:18733"]);
  });

  it("throws when the config file is missing", () => {
    assert.throws(
      () => readConfigFile(path.join(os.tmpdir(), "missing-relauts-spotcheck-service-config.json")),
      /Config file not found/,
    );
  });

  it("throws when the config file is not a JSON object", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotcheck-config-"));
    const filePath = path.join(dir, CONFIG_FILE_NAME);
    fs.writeFileSync(filePath, "[1]");
    assert.throws(() => readConfigFile(filePath), /JSON object/);
  });

  it("updates geminiApiKey in the config file and keeps other fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotcheck-config-"));
    const filePath = path.join(dir, CONFIG_FILE_NAME);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        port: 9,
        apiToken: "file-token",
        geminiApiKey: "old-key",
      }),
    );

    writeGeminiApiKeyToConfigFile(filePath, "new-key");

    const raw = readConfigFile(filePath);
    assert.equal(raw.port, 9);
    assert.equal(raw.apiToken, "file-token");
    assert.equal(raw.geminiApiKey, "new-key");
    assert.equal(readGeminiApiKeyFromConfigFile(filePath), "new-key");
  });

  it("mutates geminiApiKey on a loaded config object", () => {
    const config = loadConfig({ geminiApiKey: "old-key" });
    setGeminiApiKey(config, "new-key");
    assert.equal(config.geminiApiKey, "new-key");
  });
});

