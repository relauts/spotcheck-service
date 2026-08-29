import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  defaultSystemPromptVars,
  loadSystemPrompt,
  osLabel,
  renderSystemPrompt,
} from "../../src/computer-use/system-prompt.js";

describe("osLabel", () => {
  it("names Chromium on the host OS", () => {
    assert.equal(osLabel("darwin"), "Chromium on macOS");
    assert.equal(osLabel("win32"), "Chromium on Windows");
    assert.equal(osLabel("linux"), "Chromium on Linux");
  });
});

describe("renderSystemPrompt", () => {
  it("fills template placeholders", () => {
    const rendered = renderSystemPrompt(
      "os={{os}} size={{display_width}}x{{display_height}} keys={{keyboard_layout}}",
      {
        os: "Chromium on macOS",
        displayWidth: 1024,
        displayHeight: 768,
        keyboardLayout: "en-US",
      },
    );

    assert.equal(rendered, "os=Chromium on macOS size=1024x768 keys=en-US");
  });
});

describe("loadSystemPrompt", () => {
  it("loads files/system_prompt.txt with viewport size", async () => {
    const rendered = await loadSystemPrompt(defaultSystemPromptVars(1024, 768, "darwin", "en-US"));

    assert.match(rendered, /strict browser testing agent/);
    assert.match(rendered, /Chromium on macOS/);
    assert.match(rendered, /1024x768/);
    assert.match(rendered, /en-US/);
    assert.doesNotMatch(rendered, /\{\{/);
  });

  it("rejects an empty file", async () => {
    const filePath = path.join(os.tmpdir(), `system-prompt-${Date.now()}.txt`);
    await fs.writeFile(filePath, "   \n");

    await assert.rejects(loadSystemPrompt(defaultSystemPromptVars(1, 1), filePath), /empty/);
  });
});
