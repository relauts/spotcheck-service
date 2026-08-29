import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../../src/shared/main-module.js";

describe("isMainModule", () => {
  it("recognizes a direct entry path", () => {
    const filePath = path.resolve("dist/web/server.js");

    assert.equal(isMainModule(pathToFileURL(filePath).href, filePath), true);
  });

  it("recognizes an npm-style symlink entry", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotcheck-main-"));
    const target = path.join(directory, "server.js");
    const entry = path.join(directory, "spotcheck");

    try {
      await fs.writeFile(target, "");
      try {
        await fs.symlink(target, entry);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          context.skip("Creating symlinks is not permitted");
          return;
        }
        throw error;
      }

      assert.equal(isMainModule(pathToFileURL(target).href, entry), true);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an empty entry path", () => {
    assert.equal(isMainModule(import.meta.url, ""), false);
  });
});
