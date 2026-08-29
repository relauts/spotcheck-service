import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CREATE_DEFAULT_FILE,
  SavedExistsError,
  SavedNameError,
  SavedNotFoundError,
  deleteSavedFile,
  ensureCreateDefaultFile,
  listSavedFiles,
  normalizeSavedFileName,
  overwriteSavedFile,
  parseCreateItems,
  parseSavedItems,
  readSavedFile,
  uniqueSavedItems,
  upsertSavedFile,
  writeSavedFile,
  type SavedPromptItem,
} from "../../src/api/saved.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "saved-"));
  tempDirs.push(dir);
  return dir;
}

const sample: SavedPromptItem = {
  sequence: 1,
  id: "cell-1",
  prompt: "open example.com",
  model: "gemini-3.6-flash",
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("normalizeSavedFileName", () => {
  it("adds .json when missing", () => {
    assert.equal(normalizeSavedFileName(" my-flow "), "my-flow.json");
  });

  it("keeps a .json suffix", () => {
    assert.equal(normalizeSavedFileName("My Flow.JSON"), "My Flow.json");
  });

  it("rejects empty names", () => {
    assert.throws(() => normalizeSavedFileName("  "), SavedNameError);
  });

  it("rejects path pieces", () => {
    assert.throws(() => normalizeSavedFileName("../secret"), SavedNameError);
    assert.throws(() => normalizeSavedFileName("a/b"), SavedNameError);
  });
});

describe("uniqueSavedItems", () => {
  it("overwrites the same id and re-numbers sequence", () => {
    const items = uniqueSavedItems([
      { sequence: 1, id: "a", prompt: "first", model: "m1" },
      { sequence: 2, id: "b", prompt: "second", model: "m1" },
      { sequence: 3, id: "a", prompt: "first-again", model: "m2" },
    ]);
    assert.deepEqual(items, [
      { sequence: 1, id: "b", prompt: "second", model: "m1" },
      { sequence: 2, id: "a", prompt: "first-again", model: "m2" },
    ]);
  });
});

describe("parseSavedItems", () => {
  it("rejects an empty list", () => {
    assert.throws(() => parseSavedItems([]), /non-empty array/);
  });

  it("rejects invalid entries", () => {
    assert.throws(() => parseSavedItems([{ sequence: 1, id: "a" }]), /invalid saved prompt/);
  });
});

describe("parseCreateItems", () => {
  it("allows an empty list", () => {
    assert.deepEqual(parseCreateItems([]), []);
  });

  it("allows empty prompts and result fields", () => {
    assert.deepEqual(
      parseCreateItems([
        {
          sequence: 1,
          id: "cell-1",
          prompt: "",
          model: "gemini-3.6-flash",
          resultText: "{\"action\":\"summary\"}",
          costUsd: 0.12,
        },
      ]),
      [
        {
          sequence: 1,
          id: "cell-1",
          prompt: "",
          model: "gemini-3.6-flash",
          costUsd: 0.12,
          resultText: "{\"action\":\"summary\"}",
        },
      ],
    );
  });
});

describe("writeSavedFile", () => {
  it("writes a unique json array", async () => {
    const dir = await makeTempDir();
    const name = await writeSavedFile("login flow", [sample], dir);
    assert.equal(name, "login flow.json");
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    assert.deepEqual(JSON.parse(raw), [sample]);
  });

  it("rejects a reserved create-default name", async () => {
    const dir = await makeTempDir();
    await assert.rejects(() => writeSavedFile("create-default", [sample], dir), /reserved/);
  });

  it("rejects a name that already exists", async () => {
    const dir = await makeTempDir();
    await writeSavedFile("dup", [sample], dir);
    await assert.rejects(() => writeSavedFile("dup.json", [sample], dir), SavedExistsError);
  });

  it("lists json files in name order", async () => {
    const dir = await makeTempDir();
    await writeSavedFile("b", [sample], dir);
    await writeSavedFile("a", [sample], dir);
    assert.deepEqual(await listSavedFiles(dir), ["a.json", "b.json"]);
  });

  it("returns no files when the folder is missing", async () => {
    assert.deepEqual(await listSavedFiles(path.join(os.tmpdir(), "saved-missing-xyz")), []);
  });
});

describe("upsertSavedFile", () => {
  it("overwrites create-default.json", async () => {
    const dir = await makeTempDir();
    await upsertSavedFile(CREATE_DEFAULT_FILE, [], dir);
    await upsertSavedFile(CREATE_DEFAULT_FILE, [sample], dir);
    assert.deepEqual(await readSavedFile(CREATE_DEFAULT_FILE, dir), {
      fileName: CREATE_DEFAULT_FILE,
      items: [sample],
    });
  });
});

describe("overwriteSavedFile", () => {
  it("overwrites an existing file in place", async () => {
    const dir = await makeTempDir();
    await writeSavedFile("login flow", [sample], dir);
    const updated = { ...sample, prompt: "updated prompt" };
    const name = await overwriteSavedFile("login flow.json", [updated], dir);
    assert.equal(name, "login flow.json");
    assert.deepEqual(await readSavedFile(name, dir), { fileName: name, items: [updated] });
  });

  it("rejects a file that does not exist", async () => {
    const dir = await makeTempDir();
    await assert.rejects(() => overwriteSavedFile("missing.json", [sample], dir), SavedNotFoundError);
  });

  it("rejects overwriting create-default.json", async () => {
    const dir = await makeTempDir();
    await assert.rejects(() => overwriteSavedFile(CREATE_DEFAULT_FILE, [sample], dir), /reserved/);
  });
});

describe("deleteSavedFile", () => {
  it("deletes an existing file", async () => {
    const dir = await makeTempDir();
    await writeSavedFile("login flow", [sample], dir);
    const name = await deleteSavedFile("login flow.json", dir);
    assert.equal(name, "login flow.json");
    assert.deepEqual(await listSavedFiles(dir), []);
  });

  it("rejects a file that does not exist", async () => {
    const dir = await makeTempDir();
    await assert.rejects(() => deleteSavedFile("missing.json", dir), SavedNotFoundError);
  });

  it("rejects deleting create-default.json", async () => {
    const dir = await makeTempDir();
    await assert.rejects(() => deleteSavedFile(CREATE_DEFAULT_FILE, dir), /reserved/);
  });
});

describe("ensureCreateDefaultFile", () => {
  it("creates an empty create-default.json once", async () => {
    const dir = await makeTempDir();
    await ensureCreateDefaultFile(dir);
    await ensureCreateDefaultFile(dir);
    assert.deepEqual(await readSavedFile(CREATE_DEFAULT_FILE, dir), {
      fileName: CREATE_DEFAULT_FILE,
      items: [],
    });
  });
});

describe("readSavedFile", () => {
  it("reads a saved json array", async () => {
    const dir = await makeTempDir();
    await writeSavedFile("login flow", [sample], dir);
    assert.deepEqual(await readSavedFile("login flow.json", dir), {
      fileName: "login flow.json",
      items: [sample],
    });
  });

  it("rejects a missing file", async () => {
    const dir = await makeTempDir();
    await assert.rejects(() => readSavedFile("missing.json", dir), SavedNotFoundError);
  });
});
