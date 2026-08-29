import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createHistoryDocument,
  findLatestHistory,
  listHistoryRuns,
  makeHistoryFileName,
  readHistoryFile,
  serializeHistoryDetailItem,
  writeHistoryFile,
} from "../../src/api/history.js";
import { SavedNameError, SavedNotFoundError, type SavedPromptItem } from "../../src/api/saved.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const items: SavedPromptItem[] = [
  { sequence: 1, id: "a", prompt: "open site", model: "gemini-3.6-flash" },
  { sequence: 2, id: "b", prompt: "click login", model: "gemini-3.5-flash-lite" },
];

describe("makeHistoryFileName", () => {
  it("uses the saved stem plus a timestamp", () => {
    const name = makeHistoryFileName("login-flow.json", new Date("2026-08-27T14:00:00.485Z"));
    assert.equal(name, "login-flow-2026-08-27T14-00-00-485Z.json");
  });

  it("rejects a path in the saved name", () => {
    assert.throws(() => makeHistoryFileName("../secret"), SavedNameError);
  });
});

describe("history files", () => {
  it("writes and reads a run document", async () => {
    const dir = await makeTempDir();
    const document = createHistoryDocument("login-flow.json", items);
    const name = await writeHistoryFile("login-flow-2026-08-27T14-00-00-485Z.json", document, dir);
    const loaded = await readHistoryFile(name, dir);
    assert.deepEqual(loaded, {
      fileName: "login-flow.json",
      status: "running",
      current: 0,
      total: 2,
      items: [
        { sequence: 1, id: "a", prompt: "open site", model: "gemini-3.6-flash", status: "pending" },
        { sequence: 2, id: "b", prompt: "click login", model: "gemini-3.5-flash-lite", status: "pending" },
      ],
    });
  });

  it("returns not found for a missing file", async () => {
    const dir = await makeTempDir();
    await assert.rejects(readHistoryFile("missing.json", dir), SavedNotFoundError);
  });
});

describe("serializeHistoryDetailItem", () => {
  it("keeps prompt, model, sequence, and screenshots", () => {
    assert.deepEqual(
      serializeHistoryDetailItem(
        {
          sequence: 2,
          id: "b",
          prompt: "click login",
          model: "gemini-3.6-flash",
          status: "done",
          resultText: "Logged in.",
        },
        ["run/0002-b/0001-start.webp"],
      ),
      {
        sequence: 2,
        prompt: "click login",
        model: "gemini-3.6-flash",
        resultText: "Logged in.",
        screenshots: ["run/0002-b/0001-start.webp"],
      },
    );
  });

  it("omits resultText when missing", () => {
    assert.deepEqual(
      serializeHistoryDetailItem(
        {
          sequence: 1,
          id: "a",
          prompt: "open site",
          model: "gemini-3.6-flash",
          status: "pending",
        },
        [],
      ),
      {
        sequence: 1,
        prompt: "open site",
        model: "gemini-3.6-flash",
        screenshots: [],
      },
    );
  });
});

describe("findLatestHistory", () => {
  it("picks the newest matching history file by mtime", async () => {
    const dir = await makeTempDir();
    const older = createHistoryDocument("login-flow.json", items);
    const newer = { ...createHistoryDocument("login-flow.json", items), status: "done" as const, current: 2 };
    const other = createHistoryDocument("other.json", items);
    await writeHistoryFile("login-flow-2026-08-27T14-00-00-000Z.json", older, dir);
    await writeHistoryFile("login-flow-2026-08-27T15-00-00-000Z.json", newer, dir);
    await writeHistoryFile("other-2026-08-27T16-00-00-000Z.json", other, dir);

    const oldPath = path.join(dir, "login-flow-2026-08-27T14-00-00-000Z.json");
    const newPath = path.join(dir, "login-flow-2026-08-27T15-00-00-000Z.json");
    await fs.utimes(oldPath, new Date("2026-08-27T14:00:00Z"), new Date("2026-08-27T14:00:00Z"));
    await fs.utimes(newPath, new Date("2026-08-27T15:00:00Z"), new Date("2026-08-27T15:00:00Z"));

    const latest = await findLatestHistory("login-flow.json", dir);
    assert.equal(latest.historyFile, "login-flow-2026-08-27T15-00-00-000Z.json");
    assert.equal(latest.document.status, "done");
  });

  it("does not mix similar saved names", async () => {
    const dir = await makeTempDir();
    await writeHistoryFile(
      "login-2026-08-27T15-00-00-000Z.json",
      createHistoryDocument("login.json", items),
      dir,
    );
    await writeHistoryFile(
      "login-flow-2026-08-27T16-00-00-000Z.json",
      createHistoryDocument("login-flow.json", items),
      dir,
    );

    const latest = await findLatestHistory("login.json", dir);
    assert.equal(latest.historyFile, "login-2026-08-27T15-00-00-000Z.json");
    assert.equal(latest.document.fileName, "login.json");
  });

  it("returns not found when no history exists for that saved file", async () => {
    const dir = await makeTempDir();
    await writeHistoryFile(
      "other-2026-08-27T16-00-00-000Z.json",
      createHistoryDocument("other.json", items),
      dir,
    );
    await assert.rejects(findLatestHistory("login-flow.json", dir), SavedNotFoundError);
  });
});

describe("listHistoryRuns", () => {
  it("returns an empty list when the directory is missing", async () => {
    const dir = path.join(await makeTempDir(), "missing");
    assert.deepEqual(await listHistoryRuns(dir), []);
  });

  it("returns an empty list when the directory has no history files", async () => {
    const dir = await makeTempDir();
    assert.deepEqual(await listHistoryRuns(dir), []);
  });

  it("lists all runs newest first and skips invalid files", async () => {
    const dir = await makeTempDir();
    const older = { ...createHistoryDocument("login-flow.json", items), status: "error" as const };
    const newer = { ...createHistoryDocument("login-flow.json", items), status: "done" as const, current: 2 };
    const running = createHistoryDocument("other.json", items);
    const stopped = { ...createHistoryDocument("other.json", items), status: "stopped" as const };
    await writeHistoryFile("login-flow-2026-08-27T14-00-00-000Z.json", older, dir);
    await writeHistoryFile("login-flow-2026-08-27T15-00-00-000Z.json", newer, dir);
    await writeHistoryFile("other-2026-08-27T16-00-00-000Z.json", running, dir);
    await writeHistoryFile("other-2026-08-27T13-00-00-000Z.json", stopped, dir);
    await fs.writeFile(path.join(dir, "broken.json"), "{ not json");
    await fs.writeFile(
      path.join(dir, "bad-status.json"),
      `${JSON.stringify({ ...createHistoryDocument("login-flow.json", items), status: "unknown" }, null, 2)}\n`,
    );
    await fs.writeFile(path.join(dir, "notes.txt"), "ignore");

    await fs.utimes(
      path.join(dir, "login-flow-2026-08-27T14-00-00-000Z.json"),
      new Date("2026-08-27T14:00:00Z"),
      new Date("2026-08-27T14:00:00Z"),
    );
    await fs.utimes(
      path.join(dir, "login-flow-2026-08-27T15-00-00-000Z.json"),
      new Date("2026-08-27T15:00:00Z"),
      new Date("2026-08-27T15:00:00Z"),
    );
    await fs.utimes(
      path.join(dir, "other-2026-08-27T16-00-00-000Z.json"),
      new Date("2026-08-27T16:00:00Z"),
      new Date("2026-08-27T16:00:00Z"),
    );
    await fs.utimes(
      path.join(dir, "other-2026-08-27T13-00-00-000Z.json"),
      new Date("2026-08-27T13:00:00Z"),
      new Date("2026-08-27T13:00:00Z"),
    );

    assert.deepEqual(await listHistoryRuns(dir), [
      { historyFile: "other-2026-08-27T16-00-00-000Z.json", status: "running" },
      { historyFile: "login-flow-2026-08-27T15-00-00-000Z.json", status: "done" },
      { historyFile: "login-flow-2026-08-27T14-00-00-000Z.json", status: "error" },
      { historyFile: "other-2026-08-27T13-00-00-000Z.json", status: "stopped" },
    ]);
  });
});
