import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadLatestWebpBase64, readWebpAsBase64 } from "../../src/computer-use/screenshot.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("screenshot", () => {
  it("reads a webp file as base64", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-webp-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "shot.webp");
    await fs.writeFile(filePath, Buffer.from("webp"));

    assert.equal(await readWebpAsBase64(filePath), Buffer.from("webp").toString("base64"));
  });

  it("loads the latest processed webp", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-webp-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "latest.webp");
    await fs.writeFile(filePath, Buffer.from("abc"));

    const loaded = await loadLatestWebpBase64(dir);
    assert.equal(loaded.path, filePath);
    assert.equal(loaded.data, Buffer.from("abc").toString("base64"));
  });

  it("throws when no webp exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-webp-"));
    tempDirs.push(dir);
    await assert.rejects(() => loadLatestWebpBase64(dir), /No processed webp/);
  });
});
