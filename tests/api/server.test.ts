import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright";
import { createHistoryDocument, writeHistoryFile } from "../../src/api/history.js";
import { closeServiceServer, startServiceServer } from "../../src/api/server.js";
import { writeSavedFile } from "../../src/api/saved.js";
import { AgentRunError } from "../../src/computer-use/index.js";
import { BrowserClosedError, type BrowserSession } from "../../src/playwright/session.js";
import {
  CONFIG_FILE_NAME,
  loadConfig,
  readConfigFile,
  readGeminiApiKeyFromConfigFile,
} from "../../src/shared/config.js";
import { EMPTY_USAGE } from "../../src/shared/cost.js";
const TEST_TOKEN = "test-api-token";
const UI_ORIGIN = "http://127.0.0.1:18733";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

async function startTestServer(
  processedDir: string,
  deps: Omit<NonNullable<Parameters<typeof startServiceServer>[1]>, "processedDir" | "apiToken"> & {
    apiToken?: string;
    corsOrigins?: readonly string[];
  } = {},
) {
  return startServiceServer(0, {
    apiToken: TEST_TOKEN,
    corsOrigins: [UI_ORIGIN],
    processedDir,
    ...deps,
  });
}



const tempDirs: string[] = [];
const VALID_MODEL = "gemini-3.7-flash";

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-processed-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTempConfigFile(
  geminiApiKey = "old-gemini-key",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const dir = await makeTempDir();
  const filePath = path.join(dir, CONFIG_FILE_NAME);
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        apiToken: TEST_TOKEN,
        geminiApiKey,
        targetUrl: "https://example.com",
        port: 9,
        ...extra,
      },
      null,
      2,
    ),
  );
  return filePath;
}

function createFakeSession(initialOpen = false): BrowserSession & {
  open: boolean;
  closeCount: number;
  url: string;
  backCount: number;
  forwardCount: number;
  reloadCount: number;
} {
  const session = {
    open: initialOpen,
    closeCount: 0,
    url: initialOpen ? "https://example.com/" : "",
    backCount: 0,
    forwardCount: 0,
    reloadCount: 0,
    isOpen() {
      return session.open;
    },
    getStatus() {
      return { open: session.open, url: session.open ? session.url : "" };
    },
    async ensurePage() {
      session.open = true;
      if (!session.url) {
        session.url = "https://example.com/";
      }
      return { page: {} as Page, sessionReset: false };
    },
    async close() {
      session.closeCount += 1;
      session.open = false;
      session.url = "";
    },
    async goBack() {
      if (!session.open) {
        throw new BrowserClosedError();
      }
      session.backCount += 1;
      return session.getStatus();
    },
    async goForward() {
      if (!session.open) {
        throw new BrowserClosedError();
      }
      session.forwardCount += 1;
      return session.getStatus();
    },
    async reload() {
      if (!session.open) {
        throw new BrowserClosedError();
      }
      session.reloadCount += 1;
      return session.getStatus();
    },
  };
  return session;
}

function agentBody(task: string, model = VALID_MODEL): string {
  return JSON.stringify({ task, model });
}

function streamExtras(
  session: { open: boolean; url: string } = { open: false, url: "" },
  imageName = "",
) {
  return {
    session,
    screenshot: { imageName },
  };
}

const CLOSED_STREAM = streamExtras();

async function readNdjson(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("startServiceServer", () => {
  it("binds to localhost and serves health without auth", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    assert.equal(address.address, "127.0.0.1");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects protected routes without a bearer token", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects protected routes with a wrong bearer token", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(response.status, 401);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns the Gemini API key from the config JSON file", async () => {
    const processedDir = await makeTempDir();
    const configFilePath = await writeTempConfigFile("file-gemini-key");
    const config = loadConfig(readConfigFile(configFilePath));
    const server = await startTestServer(processedDir, { config, configFilePath });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/apikey`, {
        headers: authHeaders(),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { geminiApiKey: "file-gemini-key" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("updates the Gemini API key in the config JSON file and in memory", async () => {
    const processedDir = await makeTempDir();
    const configFilePath = await writeTempConfigFile("old-gemini-key");
    const config = loadConfig(readConfigFile(configFilePath));
    const server = await startTestServer(processedDir, { config, configFilePath });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const updated = await fetch(`http://127.0.0.1:${address.port}/v1/apikey`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ geminiApiKey: "new-gemini-key" }),
      });
      assert.equal(updated.status, 200);
      assert.deepEqual(await updated.json(), { ok: true });
      assert.equal(readGeminiApiKeyFromConfigFile(configFilePath), "new-gemini-key");
      assert.equal(readConfigFile(configFilePath).port, 9);
      assert.equal(config.geminiApiKey, "new-gemini-key");

      const fetched = await fetch(`http://127.0.0.1:${address.port}/v1/apikey`, {
        headers: authHeaders(),
      });
      assert.equal(fetched.status, 200);
      assert.deepEqual(await fetched.json(), { geminiApiKey: "new-gemini-key" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects an empty Gemini API key update", async () => {
    const processedDir = await makeTempDir();
    const configFilePath = await writeTempConfigFile();
    const config = loadConfig(readConfigFile(configFilePath));
    const server = await startTestServer(processedDir, { config, configFilePath });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/apikey`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ geminiApiKey: "   " }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "geminiApiKey is required" });
      assert.equal(readGeminiApiKeyFromConfigFile(configFilePath), "old-gemini-key");
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects wrong methods and missing auth on the API key route", async () => {
    const processedDir = await makeTempDir();
    const configFilePath = await writeTempConfigFile();
    const config = loadConfig(readConfigFile(configFilePath));
    const server = await startTestServer(processedDir, { config, configFilePath });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const noAuth = await fetch(`http://127.0.0.1:${address.port}/v1/apikey`);
      assert.equal(noAuth.status, 401);

      const post = await fetch(`http://127.0.0.1:${address.port}/v1/apikey`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ geminiApiKey: "new-gemini-key" }),
      });
      assert.equal(post.status, 405);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("allows CORS preflight from a configured origin", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
        method: "OPTIONS",
        headers: {
          Origin: UI_ORIGIN,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), UI_ORIGIN);
      assert.match(response.headers.get("access-control-allow-headers") ?? "", /Authorization/i);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("echoes CORS origin on authenticated JSON responses", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
        headers: authHeaders({ Origin: UI_ORIGIN }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), UI_ORIGIN);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("serves models from files/model.json", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, { headers: authHeaders() });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body));
      assert.ok(body.length > 0);
      assert.equal(body[0].model, "gemini-3.5-flash-lite");
      assert.equal(body[0].cache_price_per_million, 0.03);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("always serves the newest screenshot file name", async () => {
    const processedDir = await makeTempDir();
    const older = path.join(processedDir, "older.webp");
    const newer = path.join(processedDir, "newer.webp");
    await fs.writeFile(older, "old-webp");
    await fs.writeFile(newer, "new-webp");

    const now = Date.now();
    await fs.utimes(older, new Date(now - 2000), new Date(now - 2000));
    await fs.utimes(newer, new Date(now), new Date(now));

    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const first = await fetch(`http://127.0.0.1:${address.port}/v1/screenshot`, {
        headers: authHeaders(),
      });
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), {
        imageName: "newer.webp",
      });

      await fs.writeFile(path.join(processedDir, "newest.webp"), "newest-webp");

      const second = await fetch(`http://127.0.0.1:${address.port}/v1/screenshot`, {
        headers: authHeaders(),
      });
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), {
        imageName: "newest.webp",
      });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns 404 when no webp exists", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir);
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/screenshot`, { headers: authHeaders() });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "No processed webp yet" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("runs a task in process and returns the agent text", async () => {
    const processedDir = await makeTempDir();
    const seen: Array<{ task: string; model: string }> = [];
    const session = createFakeSession();
    const server = await startTestServer(processedDir, {
      session,
      runTask: async (task, model) => {
        seen.push({ task, model });
        session.open = true;
        return { text: "login failed", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody(
          "go https://relauts-demo.web.app/pets login with abc2@gmail.com",
          "gemini-3.6-flash",
        ),
      });
      const body = await readNdjson(response);

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /ndjson/);
      assert.deepEqual(body, [
        {
          type: "done",
          text: "login failed",
          sessionReset: false,
          browserOpen: true,
          costUsd: 0,
          ...streamExtras({ open: true, url: "" }),
        },
      ]);
      assert.deepEqual(seen, [
        {
          task: "go https://relauts-demo.web.app/pets login with abc2@gmail.com",
          model: "gemini-3.6-flash",
        },
      ]);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("reports telemetry after a successful create prompt and does not wait", async () => {
    const processedDir = await makeTempDir();
    const reports: Array<{ startedAt: Date; endedAt: Date }> = [];
    let resolveReport!: () => void;
    const reportGate = new Promise<void>((resolve) => {
      resolveReport = resolve;
    });
    const server = await startTestServer(processedDir, {
      reportAutomation: (startedAt, endedAt) => {
        reports.push({ startedAt, endedAt });
        void reportGate;
      },
      runTask: async () => ({ text: "ok", sessionReset: false }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
        body: agentBody("open site", "gemini-3.6-flash"),
      });
      assert.equal(response.status, 200);
      assert.equal((await readNdjson(response))[0]?.type, "done");
      assert.ok(Date.now() - started < 1_000);
      assert.equal(reports.length, 1);
      assert.ok(reports[0] && reports[0].endedAt.getTime() >= reports[0].startedAt.getTime());
    } finally {
      resolveReport();
      await closeServiceServer(server);
    }
  });

  it("does not report telemetry when the create prompt errors", async () => {
    const processedDir = await makeTempDir();
    const reports: unknown[] = [];
    const server = await startTestServer(processedDir, {
      reportAutomation: () => {
        reports.push("sent");
      },
      runTask: async () => {
        throw new AgentRunError("second turn failed", EMPTY_USAGE);
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
        body: agentBody("screenshot google.com", "gemini-3.5-flash-lite"),
      });
      assert.equal(response.status, 200);
      assert.equal((await readNdjson(response))[0]?.type, "error");
      assert.deepEqual(reports, []);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns sessionReset when the browser session was recreated", async () => {
    const processedDir = await makeTempDir();
    const session = createFakeSession(true);
    const server = await startTestServer(processedDir, {
      session,
      runTask: async () => ({ text: "ok", sessionReset: true }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("next step"),
      });
      const body = await readNdjson(response);

      assert.equal(response.status, 200);
      assert.deepEqual(body, [
        {
          type: "done",
          text: "ok",
          sessionReset: true,
          browserOpen: true,
          costUsd: 0,
          ...streamExtras({ open: true, url: "https://example.com/" }),
        },
      ]);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects a second task while the agent is running", async () => {
    const processedDir = await makeTempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = await startTestServer(processedDir, {
      runTask: async () => {
        started();
        await gate;
        return { text: "done", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const first = fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("first"),
      });
      await startedGate;

      const second = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("second"),
      });
      assert.equal(second.status, 409);
      assert.deepEqual(await second.json(), { error: "Agent already running" });

      release();
      const firstResponse = await first;
      assert.equal(firstResponse.status, 200);
      assert.deepEqual(await readNdjson(firstResponse), [
        {
          type: "done",
          text: "done",
          sessionReset: false,
          browserOpen: false,
          costUsd: 0,
          ...CLOSED_STREAM,
        },
      ]);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects an empty task", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async () => ({ text: "done", sessionReset: false }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("  "),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "task is required" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects a missing model", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async () => ({ text: "done", sessionReset: false }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ task: "do something" }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "model is required" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects an unknown model", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async () => ({ text: "done", sessionReset: false }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("do something", "not-a-real-model"),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Unknown model: not-a-real-model" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns the dollar cost for the selected model", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async () => ({
        text: "done",
        sessionReset: false,
        usage: { inputTokens: 10, outputTokens: 36, thoughtTokens: 0, cachedTokens: 0 },
      }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("screenshot google.com", "gemini-3.5-flash-lite"),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await readNdjson(response), [
        {
          type: "done",
          text: "done",
          sessionReset: false,
          browserOpen: false,
          costUsd: 0.000093,
          ...CLOSED_STREAM,
        },
      ]);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns cost of finished turns when the agent fails", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async () => {
        throw new AgentRunError("second turn failed", {
          inputTokens: 10,
          outputTokens: 36,
          thoughtTokens: 0,
          cachedTokens: 0,
        });
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("screenshot google.com", "gemini-3.5-flash-lite"),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await readNdjson(response), [
        {
          type: "error",
          error: "second turn failed",
          costUsd: 0.000093,
          ...CLOSED_STREAM,
        },
      ]);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("streams intent labels then the done event", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async (_task, _model, extras) => {
        await extras?.onIntent?.("click — open search");
        await extras?.onIntent?.("type — enter city");
        return { text: "ok", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("search"),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await readNdjson(response), [
        { type: "intent", label: "click — open search", ...CLOSED_STREAM },
        { type: "intent", label: "type — enter city", ...CLOSED_STREAM },
        {
          type: "done",
          text: "ok",
          sessionReset: false,
          browserOpen: false,
          costUsd: 0,
          ...CLOSED_STREAM,
        },
      ]);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("includes current session and screenshot name on agent events", async () => {
    const processedDir = await makeTempDir();
    await fs.writeFile(path.join(processedDir, "shot.webp"), "shot-bytes");
    const session = createFakeSession(true);
    const extras = streamExtras({ open: true, url: "https://example.com/" }, "shot.webp");
    const server = await startTestServer(processedDir, {
      session,
      runTask: async (_task, _model, runExtras) => {
        await runExtras?.onIntent?.("click — go");
        return { text: "ok", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("search"),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await readNdjson(response), [
        { type: "intent", label: "click — go", ...extras },
        {
          type: "done",
          text: "ok",
          sessionReset: false,
          browserOpen: true,
          costUsd: 0,
          ...extras,
        },
      ]);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("passes an abort signal into the agent run", async () => {
    const processedDir = await makeTempDir();
    let signal: AbortSignal | undefined;
    const server = await startTestServer(processedDir, {
      runTask: async (_task, _model, extras) => {
        signal = extras?.signal;
        return { text: "ok", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("search"),
      });
      assert.equal(response.status, 200);
      await readNdjson(response);
      assert.equal(signal instanceof AbortSignal, true);
      assert.equal(signal?.aborted, false);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("resolves a pending safety confirmation via /agent/safety", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async (_task, _model, extras) => {
        const confirmed = await extras?.confirmSafety?.("Buy now", "click");
        return { text: confirmed ? "confirmed" : "denied", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("buy something"),
      });
      assert.equal(response.status, 200);

      const reader = response.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();
      let buffer = "";
      const events: Record<string, unknown>[] = [];
      let safetyEvent: Record<string, unknown> | undefined;

      while (!safetyEvent) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          const event = JSON.parse(line) as Record<string, unknown>;
          events.push(event);
          if (event.type === "safety_confirm") {
            safetyEvent = event;
          }
        }
      }

      assert.equal(safetyEvent?.action, "click");
      assert.equal(safetyEvent?.explanation, "Buy now");
      assert.equal(typeof safetyEvent?.id, "string");
      assert.deepEqual(safetyEvent?.session, CLOSED_STREAM.session);
      assert.deepEqual(safetyEvent?.screenshot, CLOSED_STREAM.screenshot);

      const confirmResponse = await fetch(`http://127.0.0.1:${address.port}/v1/agent/safety`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ id: safetyEvent?.id, confirmed: true }),
      });
      assert.equal(confirmResponse.status, 200);
      assert.deepEqual(await confirmResponse.json(), { ok: true });

      let rest = buffer;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        rest += decoder.decode(chunk.value, { stream: true });
      }
      rest
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .forEach((line) => events.push(JSON.parse(line)));

      const done = events.find((event) => event.type === "done");
      assert.equal(done?.text, "confirmed");
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects /agent/safety with an unknown id", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async () => ({ text: "done", sessionReset: false }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/safety`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ id: "not-pending", confirmed: true }),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "No pending confirmation for id" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects /agent/safety with a missing or invalid body", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async () => ({ text: "done", sessionReset: false }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const missingConfirmed = await fetch(`http://127.0.0.1:${address.port}/v1/agent/safety`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ id: "abc" }),
      });
      assert.equal(missingConfirmed.status, 400);
      assert.deepEqual(await missingConfirmed.json(), { error: "confirmed must be a boolean" });

      const missingId = await fetch(`http://127.0.0.1:${address.port}/v1/agent/safety`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      assert.equal(missingId.status, 400);
      assert.deepEqual(await missingId.json(), { error: "id is required" });

      const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/v1/agent/safety`, { headers: authHeaders() });
      assert.equal(wrongMethod.status, 405);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("denies a pending safety confirmation when the client disconnects", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      runTask: async (_task, _model, extras) => {
        const confirmed = await extras?.confirmSafety?.("Buy now", "click");
        return { text: confirmed ? "confirmed" : "denied", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("buy something"),
        signal: controller.signal,
      });

      const reader = response.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();
      let buffer = "";
      let sawSafetyConfirm = false;
      while (!sawSafetyConfirm) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
        sawSafetyConfirm = buffer.includes("safety_confirm");
      }

      controller.abort();

      let released = false;
      for (let attempt = 0; attempt < 50 && !released; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const probeController = new AbortController();
        const probe = await fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
          body: agentBody("another task"),
          signal: probeController.signal,
        });
        if (probe.status !== 409) {
          released = true;
        }
        // The mocked runTask asks for safety confirmation on every call, so this
        // probe request would otherwise hang forever waiting for a response; just
        // disconnect it once we know whether the agent slot was released.
        probeController.abort();
        await probe.body?.cancel().catch(() => undefined);
      }

      assert.equal(released, true);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("reports whether the browser session is open", async () => {
    const processedDir = await makeTempDir();
    const session = createFakeSession();
    const server = await startTestServer(processedDir, { session });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const closed = await fetch(`http://127.0.0.1:${address.port}/v1/session`, { headers: authHeaders() });
      assert.equal(closed.status, 200);
      assert.deepEqual(await closed.json(), { open: false, url: "" });

      session.open = true;
      session.url = "https://example.com/pets";
      const opened = await fetch(`http://127.0.0.1:${address.port}/v1/session`, { headers: authHeaders() });
      assert.equal(opened.status, 200);
      assert.deepEqual(await opened.json(), { open: true, url: "https://example.com/pets" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects non-GET session status", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { session: createFakeSession() });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const status = await fetch(`http://127.0.0.1:${address.port}/v1/session`, { headers: authHeaders(), method: "POST" });
      assert.equal(status.status, 405);

      const backGet = await fetch(`http://127.0.0.1:${address.port}/v1/session/back`, { headers: authHeaders() });
      assert.equal(backGet.status, 405);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("runs back, forward, and reload on the open browser session", async () => {
    const processedDir = await makeTempDir();
    const session = createFakeSession(true);
    const server = await startTestServer(processedDir, { session });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const back = await fetch(`http://127.0.0.1:${address.port}/v1/session/back`, { headers: authHeaders(), method: "POST" });
      assert.equal(back.status, 200);
      assert.deepEqual(await back.json(), { open: true, url: "https://example.com/" });
      assert.equal(session.backCount, 1);

      const forward = await fetch(`http://127.0.0.1:${address.port}/v1/session/forward`, { headers: authHeaders(), method: "POST",
      });
      assert.equal(forward.status, 200);
      assert.equal(session.forwardCount, 1);

      const reload = await fetch(`http://127.0.0.1:${address.port}/v1/session/reload`, { headers: authHeaders(), method: "POST",
      });
      assert.equal(reload.status, 200);
      assert.equal(session.reloadCount, 1);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects chrome navigation when the browser is closed", async () => {
    const processedDir = await makeTempDir();
    const session = createFakeSession();
    const server = await startTestServer(processedDir, { session });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/session/back`, { headers: authHeaders(), method: "POST",
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "Browser is closed" });
      assert.equal(session.backCount, 0);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects chrome navigation while the agent is running", async () => {
    const processedDir = await makeTempDir();
    const session = createFakeSession(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = await startTestServer(processedDir, {
      session,
      runTask: async () => {
        started();
        await gate;
        return { text: "done", sessionReset: false };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const first = fetch(`http://127.0.0.1:${address.port}/v1/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: agentBody("first"),
      });
      await startedGate;

      const back = await fetch(`http://127.0.0.1:${address.port}/v1/session/back`, { headers: authHeaders(), method: "POST" });
      assert.equal(back.status, 409);
      assert.deepEqual(await back.json(), { error: "Agent already running" });
      assert.equal(session.backCount, 0);

      release();
      assert.equal((await first).status, 200);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("lists saved json files", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    await fs.writeFile(path.join(savedDir, "login.json"), "[]\n");
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, { headers: authHeaders() });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { files: ["login.json"] });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("saves prompt items to a unique json file", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    const items = [
      {
        sequence: 1,
        id: "11111111-1111-1111-1111-111111111111",
        prompt: "open example.com",
        model: VALID_MODEL,
      },
    ];

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "login-flow", items }),
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { fileName: "login-flow.json" });
      const raw = await fs.readFile(path.join(savedDir, "login-flow.json"), "utf8");
      assert.deepEqual(JSON.parse(raw), items);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects a saved file name that already exists", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    const body = JSON.stringify({
      fileName: "dup",
      items: [
        {
          sequence: 1,
          id: "11111111-1111-1111-1111-111111111111",
          prompt: "open example.com",
          model: VALID_MODEL,
        },
      ],
    });

    try {
      const first = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body,
      });
      assert.equal(first.status, 201);

      const second = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body,
      });
      assert.equal(second.status, 409);
      assert.deepEqual(await second.json(), { error: "File already exists: dup.json" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects saved items with an unknown model", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "bad-model",
          items: [
            {
              sequence: 1,
              id: "11111111-1111-1111-1111-111111111111",
              prompt: "open example.com",
              model: "not-a-real-model",
            },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Unknown model: not-a-real-model" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns one saved file as cells data", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    const items = [
      {
        sequence: 1,
        id: "11111111-1111-1111-1111-111111111111",
        prompt: "open example.com",
        model: VALID_MODEL,
      },
      {
        sequence: 2,
        id: "22222222-2222-2222-2222-222222222222",
        prompt: "click login",
        model: VALID_MODEL,
      },
    ];

    try {
      const created = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "login-flow", items }),
      });
      assert.equal(created.status, 201);

      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved/login-flow.json`, { headers: authHeaders() });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { fileName: "login-flow.json", items });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns 404 for a missing saved file", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved/missing.json`, { headers: authHeaders() });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Saved file not found: missing.json" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("hides create-default.json from the saved list", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const listed = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, { headers: authHeaders() });
      assert.equal(listed.status, 200);
      assert.deepEqual(await listed.json(), { files: [] });

      const created = await fetch(`http://127.0.0.1:${address.port}/v1/saved/create-default.json`, { headers: authHeaders() });
      assert.equal(created.status, 200);
      assert.deepEqual(await created.json(), { fileName: "create-default.json", items: [] });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("overwrites create-default.json with create cells", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    const items = [
      {
        sequence: 1,
        id: "11111111-1111-1111-1111-111111111111",
        prompt: "open example.com",
        model: VALID_MODEL,
        resultText: '{"action":"summary","summary":"opened","validations":[]}',
        costUsd: 0.01,
      },
    ];

    try {
      const put = await fetch(`http://127.0.0.1:${address.port}/v1/saved/create-default.json`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      assert.equal(put.status, 200);
      assert.deepEqual(await put.json(), { fileName: "create-default.json" });

      const get = await fetch(`http://127.0.0.1:${address.port}/v1/saved/create-default.json`, { headers: authHeaders() });
      assert.equal(get.status, 200);
      assert.deepEqual(await get.json(), { fileName: "create-default.json", items });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("overwrites a named saved file with PUT", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    const original = [
      {
        sequence: 1,
        id: "11111111-1111-1111-1111-111111111111",
        prompt: "open example.com",
        model: VALID_MODEL,
      },
    ];
    const updated = [
      {
        sequence: 1,
        id: "11111111-1111-1111-1111-111111111111",
        prompt: "open example.com then log in",
        model: VALID_MODEL,
      },
    ];

    try {
      const created = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "login-flow", items: original }),
      });
      assert.equal(created.status, 201);

      const put = await fetch(`http://127.0.0.1:${address.port}/v1/saved/login-flow.json`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({ items: updated }),
      });
      assert.equal(put.status, 200);
      assert.deepEqual(await put.json(), { fileName: "login-flow.json" });

      const get = await fetch(`http://127.0.0.1:${address.port}/v1/saved/login-flow.json`, { headers: authHeaders() });
      assert.deepEqual(await get.json(), { fileName: "login-flow.json", items: updated });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns 404 when PUT targets a missing saved file", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved/missing.json`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              sequence: 1,
              id: "11111111-1111-1111-1111-111111111111",
              prompt: "open example.com",
              model: VALID_MODEL,
            },
          ],
        }),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Saved file not found: missing.json" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("deletes a named saved file with DELETE", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const created = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "login-flow",
          items: [
            {
              sequence: 1,
              id: "11111111-1111-1111-1111-111111111111",
              prompt: "open example.com",
              model: VALID_MODEL,
            },
          ],
        }),
      });
      assert.equal(created.status, 201);

      const deleted = await fetch(`http://127.0.0.1:${address.port}/v1/saved/login-flow.json`, { headers: authHeaders(), method: "DELETE",
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { fileName: "login-flow.json" });

      const listed = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, { headers: authHeaders() });
      assert.deepEqual(await listed.json(), { files: [] });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns 404 when DELETE targets a missing saved file", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved/missing.json`, { headers: authHeaders(), method: "DELETE",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Saved file not found: missing.json" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects saving a named file as create-default", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, { savedDir });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`,  "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "create-default",
          items: [
            {
              sequence: 1,
              id: "11111111-1111-1111-1111-111111111111",
              prompt: "open example.com",
              model: VALID_MODEL,
            },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "create-default.json is reserved" });
    } finally {
      await closeServiceServer(server);
    }
  });
});

describe("closeWebServer", () => {
  it("does nothing when server is missing", async () => {
    await assert.doesNotReject(() => closeServiceServer(undefined));
  });

  it("closes the browser session with the HTTP server", async () => {
    const processedDir = await makeTempDir();
    const session = createFakeSession(true);
    const server = await startTestServer(processedDir, { session });

    await closeServiceServer(server);
    assert.equal(session.open, false);
    assert.equal(session.closeCount, 1);
  });
});

describe("saved run API", () => {
  function jsonHeaders(): Record<string, string> {
    return authHeaders({ "Content-Type": "application/json" });
  }

  async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await check()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out");
  }

  it("starts a saved run, reports status, and does not use the live session", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "login-flow.json",
      [
        { sequence: 1, id: "a", prompt: "open site", model: VALID_MODEL },
        { sequence: 2, id: "b", prompt: "click login", model: VALID_MODEL },
      ],
      savedDir,
    );
    const live = createFakeSession(true);
    live.url = "https://example.com/live";
    const extra = createFakeSession();
    const server = await startTestServer(processedDir, {
      session: live,
      savedDir,
      historyDir,
      createSavedRunSession: () => extra,
      savedRunTask: async (task) => ({ text: `did ${task}`, sessionReset: false, usage: EMPTY_USAGE }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const started = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "login-flow.json" }),
      });
      assert.equal(started.status, 202);
      const body = (await started.json()) as { historyFile: string };
      assert.match(body.historyFile, /^login-flow-.*\.json$/);

      await waitUntil(async () => {
        const status = await fetch(`http://127.0.0.1:${address.port}/v1/history/status`, {
          headers: jsonHeaders(),
          method: "POST",
          body: JSON.stringify({ fileName: "login-flow.json" }),
        });
        const document = (await status.json()) as { status: string };
        return document.status === "done";
      });

      const status = await fetch(`http://127.0.0.1:${address.port}/v1/history/status`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "login-flow.json" }),
      });
      assert.equal(status.status, 200);
      const document = (await status.json()) as {
        fileName: string;
        historyFile: string;
        screenshotPath: string;
        status: string;
        current: number;
        total: number;
        items: Array<{ resultText?: string }>;
      };
      assert.equal(document.fileName, "login-flow.json");
      assert.equal(document.historyFile, body.historyFile);
      assert.equal(document.screenshotPath, "");
      assert.equal(document.status, "done");
      assert.equal(document.current, 2);
      assert.equal(document.total, 2);
      assert.equal(document.items[0]?.resultText, "did open site");
      assert.equal(live.url, "https://example.com/live");
      assert.equal(extra.closeCount, 1);

      const liveStatus = await fetch(`http://127.0.0.1:${address.port}/v1/session`, { headers: authHeaders() });
      assert.deepEqual(await liveStatus.json(), { open: true, url: "https://example.com/live" });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("stops a running saved execution", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "slow.json",
      [{ sequence: 1, id: "a", prompt: "first", model: VALID_MODEL }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const extra = createFakeSession();
    const server = await startTestServer(processedDir, {
      session: createFakeSession(true),
      savedDir,
      historyDir,
      createSavedRunSession: () => extra,
      savedRunTask: async (_task, _model, _session, extras) => {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            extras?.signal?.removeEventListener("abort", onAbort);
            reject(new AgentRunError("Agent stopped", EMPTY_USAGE));
          };
          extras?.signal?.addEventListener("abort", onAbort);
          void gate.then(() => {
            extras?.signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        return { text: "done", sessionReset: false, usage: EMPTY_USAGE };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const started = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "slow.json" }),
      });
      assert.equal(started.status, 202);
      const { historyFile } = (await started.json()) as { historyFile: string };
      assert.ok(historyFile);

      await waitUntil(async () => {
        const status = await fetch(`http://127.0.0.1:${address.port}/v1/history/status`, {
          headers: jsonHeaders(),
          method: "POST",
          body: JSON.stringify({ fileName: "slow.json" }),
        });
        if (!status.ok) {
          return false;
        }
        const document = (await status.json()) as { items?: Array<{ status: string }> };
        return document.items?.[0]?.status === "running";
      });

      const stopped = await fetch(`http://127.0.0.1:${address.port}/v1/history/stop`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "slow.json" }),
      });
      assert.equal(stopped.status, 200);
      assert.deepEqual(await stopped.json(), { ok: true });

      const status = await fetch(`http://127.0.0.1:${address.port}/v1/history/status`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "slow.json" }),
      });
      const document = (await status.json()) as { status: string };
      assert.equal(document.status, "stopped");
      assert.equal(extra.closeCount, 1);
    } finally {
      release();
      await closeServiceServer(server);
    }
  });

  it("keeps live back/forward available while a saved run is in progress", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "slow.json",
      [{ sequence: 1, id: "a", prompt: "first", model: VALID_MODEL }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = createFakeSession(true);
    const server = await startTestServer(processedDir, {
      session: live,
      savedDir,
      historyDir,
      createSavedRunSession: () => createFakeSession(),
      savedRunTask: async () => {
        await gate;
        return { text: "ok", sessionReset: false, usage: EMPTY_USAGE };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const started = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "slow.json" }),
      });
      assert.equal(started.status, 202);

      const back = await fetch(`http://127.0.0.1:${address.port}/v1/session/back`, {
        headers: authHeaders(),
        method: "POST",
      });
      assert.equal(back.status, 200);
      assert.equal(live.backCount, 1);
    } finally {
      release();
      await closeServiceServer(server);
    }
  });

  it("rejects a second saved run with 409", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "flow.json",
      [{ sequence: 1, id: "a", prompt: "first", model: VALID_MODEL }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir,
      historyDir,
      createSavedRunSession: () => createFakeSession(),
      savedRunTask: async () => {
        await gate;
        return { text: "ok", sessionReset: false, usage: EMPTY_USAGE };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const first = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "flow.json" }),
      });
      assert.equal(first.status, 202);
      const second = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "flow.json" }),
      });
      assert.equal(second.status, 409);
      assert.deepEqual(await second.json(), { error: "Saved run already running for this file" });
    } finally {
      release();
      await closeServiceServer(server);
    }
  });

  it("starts a second saved file while the first is running", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "alpha.json",
      [{ sequence: 1, id: "a", prompt: "first", model: VALID_MODEL }],
      savedDir,
    );
    await writeSavedFile(
      "beta.json",
      [{ sequence: 1, id: "b", prompt: "second", model: VALID_MODEL }],
      savedDir,
    );
    await writeSavedFile(
      "gamma.json",
      [{ sequence: 1, id: "c", prompt: "third", model: VALID_MODEL }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const extras: ReturnType<typeof createFakeSession>[] = [];
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir,
      historyDir,
      createSavedRunSession: () => {
        const extra = createFakeSession();
        extras.push(extra);
        return extra;
      },
      savedRunTask: async () => {
        await gate;
        return { text: "ok", sessionReset: false, usage: EMPTY_USAGE };
      },
      config: loadConfig({ MAX_SAVED_RUNS: "2" }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const first = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "alpha.json" }),
      });
      const second = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "beta.json" }),
      });
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      assert.equal(extras.length, 2);

      const third = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "gamma.json" }),
      });
      assert.equal(third.status, 409);
      assert.deepEqual(await third.json(), { error: "Saved run limit reached" });
    } finally {
      release();
      await closeServiceServer(server);
    }
  });

  it("lists running saved files", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "beta.json",
      [{ sequence: 1, id: "b", prompt: "second", model: VALID_MODEL }],
      savedDir,
    );
    await writeSavedFile(
      "alpha.json",
      [{ sequence: 1, id: "a", prompt: "first", model: VALID_MODEL }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir,
      historyDir,
      createSavedRunSession: () => createFakeSession(),
      savedRunTask: async () => {
        await gate;
        return { text: "ok", sessionReset: false, usage: EMPTY_USAGE };
      },
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const empty = await fetch(`http://127.0.0.1:${address.port}/v1/saved/running`, {
        headers: authHeaders(),
      });
      assert.equal(empty.status, 200);
      assert.deepEqual(await empty.json(), { files: [] });

      assert.equal(
        (
          await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
            headers: jsonHeaders(),
            method: "POST",
            body: JSON.stringify({ fileName: "beta.json" }),
          })
        ).status,
        202,
      );
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
            headers: jsonHeaders(),
            method: "POST",
            body: JSON.stringify({ fileName: "alpha.json" }),
          })
        ).status,
        202,
      );

      const listed = await fetch(`http://127.0.0.1:${address.port}/v1/saved/running`, {
        headers: authHeaders(),
      });
      assert.equal(listed.status, 200);
      assert.deepEqual(await listed.json(), { files: ["alpha.json", "beta.json"] });
    } finally {
      release();
      await closeServiceServer(server);
    }
  });

  it("rejects running create-default.json", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir,
      historyDir: await makeTempDir(),
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "create-default.json" }),
      });
      assert.equal(response.status, 400);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("accepts a saved file name with spaces in the body", async () => {
    const processedDir = await makeTempDir();
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "END TO END - 01.json",
      [{ sequence: 1, id: "a", prompt: "open site", model: VALID_MODEL }],
      savedDir,
    );
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir,
      historyDir,
      createSavedRunSession: () => createFakeSession(),
      savedRunTask: async () => ({ text: "ok", sessionReset: false, usage: EMPTY_USAGE }),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const started = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "END TO END - 01.json" }),
      });
      assert.equal(started.status, 202);
      const body = (await started.json()) as { historyFile: string };
      assert.match(body.historyFile, /^END TO END - 01-.*\.json$/);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("rejects a missing fileName", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir: await makeTempDir(),
      historyDir: await makeTempDir(),
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/saved/run`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 400);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("lists history runs newest first", async () => {
    const processedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeHistoryFile(
      "login-flow-2026-08-27T14-00-00-000Z.json",
      { ...createHistoryDocument("login-flow.json", [{ sequence: 1, id: "a", prompt: "open site", model: VALID_MODEL }]), status: "error" },
      historyDir,
    );
    await writeHistoryFile(
      "login-flow-2026-08-27T15-00-00-000Z.json",
      { ...createHistoryDocument("login-flow.json", [{ sequence: 1, id: "a", prompt: "open site", model: VALID_MODEL }]), status: "done", current: 1 },
      historyDir,
    );
    await fs.utimes(
      path.join(historyDir, "login-flow-2026-08-27T14-00-00-000Z.json"),
      new Date("2026-08-27T14:00:00Z"),
      new Date("2026-08-27T14:00:00Z"),
    );
    await fs.utimes(
      path.join(historyDir, "login-flow-2026-08-27T15-00-00-000Z.json"),
      new Date("2026-08-27T15:00:00Z"),
      new Date("2026-08-27T15:00:00Z"),
    );

    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir: await makeTempDir(),
      historyDir,
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const emptyAuth = await fetch(`http://127.0.0.1:${address.port}/v1/history`);
      assert.equal(emptyAuth.status, 401);

      const listed = await fetch(`http://127.0.0.1:${address.port}/v1/history`, {
        headers: authHeaders(),
      });
      assert.equal(listed.status, 200);
      assert.deepEqual(await listed.json(), {
        runs: [
          { historyFile: "login-flow-2026-08-27T15-00-00-000Z.json", status: "done" },
          { historyFile: "login-flow-2026-08-27T14-00-00-000Z.json", status: "error" },
        ],
      });

      const notAllowed = await fetch(`http://127.0.0.1:${address.port}/v1/history`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({}),
      });
      assert.equal(notAllowed.status, 405);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns an empty history list when no runs exist", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir: await makeTempDir(),
      historyDir: await makeTempDir(),
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/history`, {
        headers: authHeaders(),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { runs: [] });
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns history detail for a historyFile", async () => {
    const processedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const historyFile = "login-flow-2026-08-27T14-00-00-000Z.json";
    const stem = "login-flow-2026-08-27T14-00-00-000Z";
    await writeHistoryFile(
      historyFile,
      {
        ...createHistoryDocument("login-flow.json", [
          { sequence: 1, id: "a", prompt: "open site", model: VALID_MODEL },
          { sequence: 2, id: "b", prompt: "click login", model: VALID_MODEL },
        ]),
        status: "done",
        current: 2,
        items: [
          {
            sequence: 1,
            id: "a",
            prompt: "open site",
            model: VALID_MODEL,
            status: "done",
            resultText: "Homepage loaded.",
          },
          {
            sequence: 2,
            id: "b",
            prompt: "click login",
            model: VALID_MODEL,
            status: "pending",
          },
        ],
      },
      historyDir,
    );
    const firstDir = path.join(processedDir, "saved-runs", stem, "0001-a");
    await fs.mkdir(firstDir, { recursive: true });
    await fs.writeFile(path.join(firstDir, "0002-click.webp"), "click");
    await fs.writeFile(path.join(firstDir, "0001-start.webp"), "start");

    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir: await makeTempDir(),
      historyDir,
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const missingAuth = await fetch(`http://127.0.0.1:${address.port}/v1/history/detail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyFile }),
      });
      assert.equal(missingAuth.status, 401);

      const response = await fetch(`http://127.0.0.1:${address.port}/v1/history/detail`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ historyFile }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        historyFile,
        status: "done",
        items: [
          {
            sequence: 1,
            prompt: "open site",
            model: VALID_MODEL,
            resultText: "Homepage loaded.",
            screenshots: [`${stem}/0001-a/0001-start.webp`, `${stem}/0001-a/0002-click.webp`],
          },
          {
            sequence: 2,
            prompt: "click login",
            model: VALID_MODEL,
            screenshots: [],
          },
        ],
      });

      const notAllowed = await fetch(`http://127.0.0.1:${address.port}/v1/history/detail`, {
        headers: authHeaders(),
      });
      assert.equal(notAllowed.status, 405);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns 404 detail when the history file is missing", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir: await makeTempDir(),
      historyDir: await makeTempDir(),
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/history/detail`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ historyFile: "login-flow-2026-08-27T14-00-00-000Z.json" }),
      });
      assert.equal(response.status, 404);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns 404 status when no history exists for the saved file", async () => {
    const processedDir = await makeTempDir();
    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir: await makeTempDir(),
      historyDir: await makeTempDir(),
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/history/status`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "login-flow.json" }),
      });
      assert.equal(response.status, 404);
    } finally {
      await closeServiceServer(server);
    }
  });

  it("returns the relative screenshot path under saved-runs", async () => {
    const processedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const historyFile = "login-flow-2026-08-27T14-00-00-000Z.json";
    const stem = "login-flow-2026-08-27T14-00-00-000Z";
    await writeHistoryFile(
      historyFile,
      createHistoryDocument("login-flow.json", [
        { sequence: 1, id: "a", prompt: "open site", model: VALID_MODEL },
      ]),
      historyDir,
    );
    const shotDir = path.join(processedDir, "saved-runs", stem, "0001-a");
    await fs.mkdir(shotDir, { recursive: true });
    await fs.writeFile(path.join(shotDir, "0002-click.webp"), "img");

    const server = await startTestServer(processedDir, {
      session: createFakeSession(),
      savedDir: await makeTempDir(),
      historyDir,
      createSavedRunSession: () => createFakeSession(),
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/history/status`, {
        headers: jsonHeaders(),
        method: "POST",
        body: JSON.stringify({ fileName: "login-flow.json" }),
      });
      assert.equal(response.status, 200);
      const document = (await response.json()) as { screenshotPath: string };
      assert.equal(document.screenshotPath, `${stem}/0001-a/0002-click.webp`);
    } finally {
      await closeServiceServer(server);
    }
  });
});
