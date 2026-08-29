import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright";
import {
  createProcessedScreenshotSaver,
  getLatestWebpPath,
  getSavedRunItemScreenshotRelPaths,
  getSavedRunScreenshotRelPath,
  savedRunItemScreenshotDir,
  savedRunQuestionFolder,
  waitForScreenshotReady,
} from "../../src/playwright/processed.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "processed-webp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("getLatestWebpPath", () => {
  it("returns undefined when the folder is missing", async () => {
    const missing = path.join(os.tmpdir(), `processed-missing-${Date.now()}`);
    assert.equal(await getLatestWebpPath(missing), undefined);
  });

  it("returns the newest webp by mtime", async () => {
    const dir = await makeTempDir();
    const older = path.join(dir, "older.webp");
    const newer = path.join(dir, "newer.webp");
    await fs.writeFile(older, "old");
    await fs.writeFile(newer, "new");
    await fs.writeFile(path.join(dir, "notes.txt"), "ignore");

    const now = Date.now();
    await fs.utimes(older, new Date(now - 2000), new Date(now - 2000));
    await fs.utimes(newer, new Date(now), new Date(now));

    assert.equal(await getLatestWebpPath(dir), newer);
  });
});

describe("getSavedRunScreenshotRelPath", () => {
  it("returns the newest file in a question folder", async () => {
    const processedDir = await makeTempDir();
    const stem = "login-flow-2026-08-27T14-00-00-000Z";
    const shotDir = path.join(processedDir, "saved-runs", stem, "0002-b");
    await fs.mkdir(shotDir, { recursive: true });
    const older = path.join(shotDir, "0001-start.webp");
    const newer = path.join(shotDir, "0002-click.webp");
    await fs.writeFile(older, "old");
    await fs.writeFile(newer, "new");
    const now = Date.now();
    await fs.utimes(older, new Date(now - 2000), new Date(now - 2000));
    await fs.utimes(newer, new Date(now), new Date(now));

    assert.equal(
      await getSavedRunScreenshotRelPath(processedDir, `${stem}.json`),
      `${stem}/0002-b/0002-click.webp`,
    );
  });

  it("returns empty when there is no screenshot", async () => {
    const processedDir = await makeTempDir();
    assert.equal(await getSavedRunScreenshotRelPath(processedDir, "missing.json"), "");
  });
});

describe("getSavedRunItemScreenshotRelPaths", () => {
  it("returns all question screenshots sorted by name", async () => {
    const processedDir = await makeTempDir();
    const historyFile = "login-flow-2026-08-27T14-00-00-000Z.json";
    const shotDir = savedRunItemScreenshotDir(processedDir, historyFile, 1, "a");
    await fs.mkdir(shotDir, { recursive: true });
    await fs.writeFile(path.join(shotDir, "0002-click.webp"), "click");
    await fs.writeFile(path.join(shotDir, "0001-start.webp"), "start");
    await fs.writeFile(path.join(shotDir, "notes.txt"), "ignore");

    assert.deepEqual(await getSavedRunItemScreenshotRelPaths(processedDir, historyFile, 1, "a"), [
      "login-flow-2026-08-27T14-00-00-000Z/0001-a/0001-start.webp",
      "login-flow-2026-08-27T14-00-00-000Z/0001-a/0002-click.webp",
    ]);
  });

  it("returns an empty list when the question folder is missing", async () => {
    const processedDir = await makeTempDir();
    assert.deepEqual(
      await getSavedRunItemScreenshotRelPaths(processedDir, "missing.json", 1, "a"),
      [],
    );
  });
});

describe("savedRunQuestionFolder", () => {
  it("pads sequence and keeps a safe id", () => {
    assert.equal(
      savedRunQuestionFolder(2, "4bff2f37-f247-4c2a-8dd2-6d13b57371be"),
      "0002-4bff2f37-f247-4c2a-8dd2-6d13b57371be",
    );
  });

  it("strips path characters from the id", () => {
    assert.equal(savedRunQuestionFolder(1, "../etc/passwd"), "0001-etc-passwd");
    assert.equal(savedRunQuestionFolder(1, "a/b\\c"), "0001-a-b-c");
    assert.equal(savedRunQuestionFolder(1, "."), "0001-id");
    assert.equal(savedRunQuestionFolder(1, ".."), "0001-id");
    assert.equal(savedRunQuestionFolder(1, "   "), "0001-id");
  });
});

describe("savedRunItemScreenshotDir", () => {
  it("nests under saved-runs / run / question", () => {
    const processedDir = "/tmp/processed";
    const historyFile = "login-flow-2026-08-27T14-00-00-000Z.json";
    assert.equal(
      savedRunItemScreenshotDir(processedDir, historyFile, 1, "a"),
      path.join(processedDir, "saved-runs", "login-flow-2026-08-27T14-00-00-000Z", "0001-a"),
    );
  });
});

describe("waitForScreenshotReady", () => {
  it("waits for load then paint before returning", async () => {
    const calls: string[] = [];
    const page = {
      isClosed: () => false,
      waitForLoadState: async () => {
        calls.push("load");
      },
      evaluate: async () => {
        calls.push("paint");
      },
    };

    await waitForScreenshotReady(page as unknown as Page);
    assert.deepEqual(calls, ["load", "paint"]);
  });

  it("skips waiting when the page is closed", async () => {
    let waited = false;
    const page = {
      isClosed: () => true,
      waitForLoadState: async () => {
        waited = true;
      },
      evaluate: async () => {
        waited = true;
      },
    };

    await waitForScreenshotReady(page as unknown as Page);
    assert.equal(waited, false);
  });

  it("continues when load wait fails", async () => {
    const calls: string[] = [];
    const page = {
      isClosed: () => false,
      waitForLoadState: async () => {
        throw new Error("Timeout 5000ms exceeded");
      },
      evaluate: async () => {
        calls.push("paint");
      },
    };

    await waitForScreenshotReady(page as unknown as Page);
    assert.deepEqual(calls, ["paint"]);
  });
});

describe("createProcessedScreenshotSaver", () => {
  it("waits for a settled page before taking the screenshot", async () => {
    const calls: string[] = [];
    const dir = await makeTempDir();
    const page = {
      isClosed: () => false,
      waitForLoadState: async () => {
        calls.push("load");
      },
      evaluate: async () => {
        calls.push("paint");
      },
      screenshot: async () => {
        calls.push("shot");
        return Buffer.from([]);
      },
    };

    const save = createProcessedScreenshotSaver(page as unknown as Page, dir);
    const filePath = await save("scroll");

    assert.deepEqual(calls, ["load", "paint", "shot"]);
    assert.match(path.basename(filePath), /scroll\.webp$/);
  });
});
