import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright";
import { readHistoryFile, writeHistoryFile } from "../../src/api/history.js";
import { SavedNotFoundError, writeSavedFile } from "../../src/api/saved.js";
import {
  SavedRunBusyError,
  SavedRunFinishedError,
  SavedRunLimitError,
  SavedRunNotRunningError,
  createSavedRunManager,
  denySavedRunSafety,
} from "../../src/api/saved-run.js";
import { AgentRunError, type AgentRunResult } from "../../src/computer-use/index.js";
import { BrowserClosedError, type BrowserSession } from "../../src/playwright/session.js";
import { loadConfig } from "../../src/shared/config.js";
import { EMPTY_USAGE } from "../../src/shared/cost.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "saved-run-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createFakeSession(): BrowserSession & { closeCount: number; ensureCount: number } {
  const session = {
    closeCount: 0,
    ensureCount: 0,
    isOpen() {
      return session.ensureCount > session.closeCount;
    },
    getStatus() {
      return { open: session.isOpen(), url: session.isOpen() ? "https://example.com/" : "" };
    },
    async ensurePage() {
      session.ensureCount += 1;
      return { page: {} as Page, sessionReset: false };
    },
    async close() {
      session.closeCount += 1;
    },
    async goBack() {
      throw new BrowserClosedError();
    },
    async goForward() {
      throw new BrowserClosedError();
    },
    async reload() {
      throw new BrowserClosedError();
    },
  };
  return session;
}

function okResult(text: string): AgentRunResult {
  return { text, sessionReset: false, usage: EMPTY_USAGE };
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) {
        return;
      }
    } catch {
      // History file may be mid-write.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

describe("denySavedRunSafety", () => {
  it("denies confirmation", async () => {
    await assert.rejects(denySavedRunSafety(), /Safety confirmation denied/);
  });
});

describe("createSavedRunManager", { concurrency: false }, () => {
  it("lists no running files when idle", async () => {
    const manager = createSavedRunManager({
      savedDir: await makeTempDir(),
      historyDir: await makeTempDir(),
      processedDir: await makeTempDir(),
      config: loadConfig({}),
      createSession: () => createFakeSession(),
    });
    assert.deepEqual(manager.listRunning(), []);
  });
  it("runs prompts in order on a separate session and writes history after each step", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "login-flow.json",
      [
        { sequence: 1, id: "a", prompt: "open site", model: "gemini-3.6-flash" },
        { sequence: 2, id: "b", prompt: "click login", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    const session = createFakeSession();
    const tasks: string[] = [];
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => session,
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async (task) => {
        tasks.push(task);
        return okResult(`did ${task}`);
      },
    });

    const historyFile = await manager.start("login-flow.json");
    assert.equal(historyFile, "login-flow-2026-08-27T14-00-00-000Z.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "done");

    const document = await readHistoryFile(historyFile, historyDir);
    assert.equal(document.fileName, "login-flow.json");
    assert.equal(document.status, "done");
    assert.equal(document.current, 2);
    assert.equal(document.total, 2);
    assert.equal(document.items[0]?.status, "done");
    assert.equal(document.items[0]?.resultText, "did open site");
    assert.equal(document.items[1]?.status, "done");
    assert.equal(document.items[1]?.resultText, "did click login");
    assert.deepEqual(tasks, ["open site", "click login"]);
    assert.equal(session.ensureCount, 1);
    assert.equal(session.closeCount, 1);
  });

  it("writes each prompt's screenshots into its own question folder", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "login-flow.json",
      [
        { sequence: 1, id: "a", prompt: "open site", model: "gemini-3.6-flash" },
        { sequence: 2, id: "b", prompt: "click login", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    const dirs: string[] = [];
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async (_task, _model, _session, _extras, screenshotDir) => {
        if (screenshotDir) {
          dirs.push(screenshotDir);
        }
        return okResult("ok");
      },
    });

    const historyFile = await manager.start("login-flow.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "done");

    const stem = "login-flow-2026-08-27T14-00-00-000Z";
    assert.deepEqual(dirs, [
      path.join(processedDir, "saved-runs", stem, "0001-a"),
      path.join(processedDir, "saved-runs", stem, "0002-b"),
    ]);
  });

  it("stops after the first failure and leaves later prompts pending", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "mixed.json",
      [
        { sequence: 1, id: "b", prompt: "do work", model: "gemini-3.6-flash" },
        { sequence: 2, id: "c", prompt: "later", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    const tasks: string[] = [];
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async (task) => {
        tasks.push(task);
        throw new Error("boom");
      },
    });

    const historyFile = await manager.start("mixed.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "error");

    const document = await readHistoryFile(historyFile, historyDir);
    assert.equal(document.items[0]?.status, "error");
    assert.equal(document.items[0]?.error, "boom");
    assert.equal(document.items[1]?.status, "pending");
    assert.deepEqual(tasks, ["do work"]);
  });

  it("aborts the current prompt on stop", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "slow.json",
      [
        { sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" },
        { sequence: 2, id: "b", prompt: "second", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async (_task, _model, _session, extras) => {
        await new Promise<AgentRunResult>((resolve, reject) => {
          const onAbort = (): void => {
            extras?.signal?.removeEventListener("abort", onAbort);
            reject(new AgentRunError("Agent stopped", EMPTY_USAGE));
          };
          extras?.signal?.addEventListener("abort", onAbort);
          void gate.then(() => {
            extras?.signal?.removeEventListener("abort", onAbort);
            resolve(okResult("done"));
          });
        });
        return okResult("done");
      },
    });

    const historyFile = await manager.start("slow.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).items[0]?.status === "running");
    await manager.stop(historyFile);
    const document = await readHistoryFile(historyFile, historyDir);
    assert.equal(document.status, "stopped");
    assert.equal(document.items[1]?.status, "pending");
    release();
  });

  it("rejects a second start while one run is active", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "flow.json",
      [{ sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async () => {
        await gate;
        return okResult("ok");
      },
    });

    const historyFile = await manager.start("flow.json");
    await assert.rejects(manager.start("flow.json"), (error: unknown) => {
      assert.ok(error instanceof SavedRunBusyError);
      assert.equal(error.message, "Saved run already running for this file");
      return true;
    });
    release();
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "done");
  });

  it("runs two different files in parallel", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "alpha.json",
      [{ sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" }],
      savedDir,
    );
    await writeSavedFile(
      "beta.json",
      [{ sequence: 1, id: "b", prompt: "second", model: "gemini-3.6-flash" }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions: ReturnType<typeof createFakeSession>[] = [];
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => {
        const session = createFakeSession();
        sessions.push(session);
        return session;
      },
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async () => {
        await gate;
        return okResult("ok");
      },
    });

    const alphaHistory = await manager.start("alpha.json");
    const betaHistory = await manager.start("beta.json");
    await waitUntil(async () => (await readHistoryFile(alphaHistory, historyDir)).items[0]?.status === "running");
    await waitUntil(async () => (await readHistoryFile(betaHistory, historyDir)).items[0]?.status === "running");
    assert.equal(sessions.length, 2);
    assert.deepEqual(manager.listRunning(), ["alpha.json", "beta.json"]);

    release();
    await waitUntil(async () => (await readHistoryFile(alphaHistory, historyDir)).status === "done");
    await waitUntil(async () => (await readHistoryFile(betaHistory, historyDir)).status === "done");
    assert.equal(sessions[0]?.closeCount, 1);
    assert.equal(sessions[1]?.closeCount, 1);
    assert.deepEqual(manager.listRunning(), []);
  });

  it("rejects a third start when the cap is reached", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "alpha.json",
      [{ sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" }],
      savedDir,
    );
    await writeSavedFile(
      "beta.json",
      [{ sequence: 1, id: "b", prompt: "second", model: "gemini-3.6-flash" }],
      savedDir,
    );
    await writeSavedFile(
      "gamma.json",
      [{ sequence: 1, id: "c", prompt: "third", model: "gemini-3.6-flash" }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({ MAX_SAVED_RUNS: "2" }),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async () => {
        await gate;
        return okResult("ok");
      },
    });

    const alphaHistory = await manager.start("alpha.json");
    const betaHistory = await manager.start("beta.json");
    await assert.rejects(manager.start("gamma.json"), (error: unknown) => {
      assert.ok(error instanceof SavedRunLimitError);
      assert.equal(error.message, "Saved run limit reached");
      return true;
    });
    release();
    await waitUntil(async () => (await readHistoryFile(alphaHistory, historyDir)).status === "done");
    await waitUntil(async () => (await readHistoryFile(betaHistory, historyDir)).status === "done");
  });

  it("stops one file and leaves the other running", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "alpha.json",
      [
        { sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" },
        { sequence: 2, id: "a2", prompt: "later", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    await writeSavedFile(
      "beta.json",
      [{ sequence: 1, id: "b", prompt: "second", model: "gemini-3.6-flash" }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async (_task, _model, _session, extras) => {
        await new Promise<AgentRunResult>((resolve, reject) => {
          const onAbort = (): void => {
            extras?.signal?.removeEventListener("abort", onAbort);
            reject(new AgentRunError("Agent stopped", EMPTY_USAGE));
          };
          extras?.signal?.addEventListener("abort", onAbort);
          void gate.then(() => {
            extras?.signal?.removeEventListener("abort", onAbort);
            resolve(okResult("ok"));
          });
        });
        return okResult("ok");
      },
    });

    const alphaHistory = await manager.start("alpha.json");
    const betaHistory = await manager.start("beta.json");
    await waitUntil(async () => (await readHistoryFile(alphaHistory, historyDir)).items[0]?.status === "running");
    await waitUntil(async () => (await readHistoryFile(betaHistory, historyDir)).items[0]?.status === "running");

    await manager.stop(alphaHistory);
    const alpha = await readHistoryFile(alphaHistory, historyDir);
    const beta = await readHistoryFile(betaHistory, historyDir);
    assert.equal(alpha.status, "stopped");
    assert.equal(alpha.items[1]?.status, "pending");
    assert.equal(beta.status, "running");

    release();
    await waitUntil(async () => (await readHistoryFile(betaHistory, historyDir)).status === "done");
  });

  it("rejects create-default.json", async () => {
    const savedDir = await makeTempDir();
    const manager = createSavedRunManager({
      savedDir,
      historyDir: await makeTempDir(),
      processedDir: await makeTempDir(),
      config: loadConfig({}),
      createSession: () => createFakeSession(),
    });
    await assert.rejects(manager.start("create-default.json"), /reserved/);
  });

  it("returns 409 when stopping a finished run", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    await writeSavedFile(
      "flow.json",
      [{ sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" }],
      savedDir,
    );
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir: await makeTempDir(),
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      runTask: async () => okResult("ok"),
    });
    const historyFile = await manager.start("flow.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "done");
    await assert.rejects(manager.stop(historyFile), SavedRunFinishedError);
  });

  it("returns not found when the history file is missing", async () => {
    const manager = createSavedRunManager({
      savedDir: await makeTempDir(),
      historyDir: await makeTempDir(),
      processedDir: await makeTempDir(),
      config: loadConfig({}),
      createSession: () => createFakeSession(),
    });
    await assert.rejects(manager.stop("missing.json"), SavedNotFoundError);
  });

  it("returns not running for a leftover running history file", async () => {
    const historyDir = await makeTempDir();
    await writeHistoryFile(
      "leftover-2026-08-27T14-00-00-000Z.json",
      {
        fileName: "leftover.json",
        status: "running",
        current: 1,
        total: 1,
        items: [{ sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash", status: "running" }],
      },
      historyDir,
    );
    const manager = createSavedRunManager({
      savedDir: await makeTempDir(),
      historyDir,
      processedDir: await makeTempDir(),
      config: loadConfig({}),
      createSession: () => createFakeSession(),
    });
    await assert.rejects(manager.stop("leftover-2026-08-27T14-00-00-000Z.json"), SavedRunNotRunningError);
  });

  it("reports telemetry after each successful prompt", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "login-flow.json",
      [
        { sequence: 1, id: "a", prompt: "open site", model: "gemini-3.6-flash" },
        { sequence: 2, id: "b", prompt: "click login", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    const reports: Array<{ startedAt: Date; endedAt: Date }> = [];
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      reportAutomation: (startedAt, endedAt) => {
        reports.push({ startedAt, endedAt });
      },
      runTask: async () => okResult("ok"),
    });

    const historyFile = await manager.start("login-flow.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "done");

    assert.equal(reports.length, 2);
    assert.ok(reports[0] && reports[0].endedAt.getTime() >= reports[0].startedAt.getTime());
    assert.ok(reports[1] && reports[1].endedAt.getTime() >= reports[1].startedAt.getTime());
  });

  it("does not wait for telemetry between saved-run prompts", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "login-flow.json",
      [
        { sequence: 1, id: "a", prompt: "open site", model: "gemini-3.6-flash" },
        { sequence: 2, id: "b", prompt: "click login", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      reportAutomation: async () => {
        order.push("telemetry-start");
        await gate;
        order.push("telemetry-end");
      },
      runTask: async (task) => {
        order.push(task);
        return okResult("ok");
      },
    });

    const historyFile = await manager.start("login-flow.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "done");
    assert.deepEqual(order, ["open site", "telemetry-start", "click login", "telemetry-start"]);
    release();
  });

  it("reports telemetry only for prompts that succeed before an error", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "mixed.json",
      [
        { sequence: 1, id: "a", prompt: "open site", model: "gemini-3.6-flash" },
        { sequence: 2, id: "b", prompt: "later", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    const reports: unknown[] = [];
    const manager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      reportAutomation: () => {
        reports.push("sent");
      },
      runTask: async (task) => {
        if (task === "later") {
          throw new Error("boom");
        }
        return okResult("ok");
      },
    });

    const historyFile = await manager.start("mixed.json");
    await waitUntil(async () => (await readHistoryFile(historyFile, historyDir)).status === "error");
    assert.deepEqual(reports, ["sent"]);
  });

  it("does not report telemetry for failed or stopped prompts", async () => {
    const savedDir = await makeTempDir();
    const historyDir = await makeTempDir();
    const processedDir = await makeTempDir();
    await writeSavedFile(
      "fail.json",
      [
        { sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" },
        { sequence: 2, id: "b", prompt: "later", model: "gemini-3.6-flash" },
      ],
      savedDir,
    );
    const reports: unknown[] = [];
    const failManager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:00.000Z"),
      reportAutomation: () => {
        reports.push("sent");
      },
      runTask: async () => {
        throw new Error("boom");
      },
    });

    const failHistory = await failManager.start("fail.json");
    await waitUntil(async () => (await readHistoryFile(failHistory, historyDir)).status === "error");
    assert.deepEqual(reports, []);

    await writeSavedFile(
      "slow.json",
      [{ sequence: 1, id: "a", prompt: "first", model: "gemini-3.6-flash" }],
      savedDir,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopManager = createSavedRunManager({
      savedDir,
      historyDir,
      processedDir,
      config: loadConfig({}),
      createSession: () => createFakeSession(),
      now: () => new Date("2026-08-27T14:00:01.000Z"),
      reportAutomation: () => {
        reports.push("sent");
      },
      runTask: async (_task, _model, _session, extras) => {
        await new Promise<AgentRunResult>((resolve, reject) => {
          const onAbort = (): void => {
            extras?.signal?.removeEventListener("abort", onAbort);
            reject(new AgentRunError("Agent stopped", EMPTY_USAGE));
          };
          extras?.signal?.addEventListener("abort", onAbort);
          void gate.then(() => {
            extras?.signal?.removeEventListener("abort", onAbort);
            resolve(okResult("ok"));
          });
        });
        return okResult("ok");
      },
    });

    const stopHistory = await stopManager.start("slow.json");
    await waitUntil(async () => (await readHistoryFile(stopHistory, historyDir)).items[0]?.status === "running");
    await stopManager.stop(stopHistory);
    release();
    assert.deepEqual(reports, []);
  });
});
