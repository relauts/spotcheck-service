import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import {
  PLAYWRIGHT_ACTION_NAMES,
  createPageActions,
  type PlaywrightActions,
} from "../../src/playwright/actions.js";
import { PROCESSED_DIR } from "../../src/playwright/processed.js";
import { closeBrowser, launchLightChromium } from "../../src/playwright/chromium.js";
import { loadConfig } from "../../src/shared/config.js";

const fixtureHtml = `
<!DOCTYPE html>
<html>
  <body>
    <button id="btn">Click</button>
    <button id="dbl">Double</button>
    <input id="name" />
    <input id="typed" />
    <input type="checkbox" id="agree" />
    <select id="color">
      <option value="red">Red</option>
      <option value="blue">Blue</option>
    </select>
    <input type="file" id="file" />
    <p id="status">idle</p>
    <div id="bottom" style="margin-top: 2000px">bottom</div>
    <script>
      document.getElementById("btn").addEventListener("click", () => {
        document.getElementById("status").textContent = "clicked";
      });
      document.getElementById("dbl").addEventListener("dblclick", () => {
        document.getElementById("status").textContent = "dblclicked";
      });
    </script>
  </body>
</html>
`;

describe("createPageActions", () => {
  let browser: Browser;
  let page: Page;
  let actions: PlaywrightActions;

  before(async () => {
    browser = await launchLightChromium(
      loadConfig({
        TARGET_URL: "https://example.com",
        HEADLESS: "true",
        CHROMIUM_SANDBOX: "true",
        NAVIGATION_TIMEOUT_MS: "30000",
        PORT: "3000",
      }),
    );
    page = await browser.newPage({
      hasTouch: true,
      viewport: { width: 1024, height: 768 },
    });
    actions = createPageActions(page);
  });

  after(async () => {
    await closeBrowser(browser);
  });

  it("exposes every supported Playwright action", () => {
    for (const name of PLAYWRIGHT_ACTION_NAMES) {
      const action = actions[name];
      assert.ok(typeof action === "function" || typeof action === "object");
    }
  });

  it("runs locator, keyboard, mouse, and navigation actions", async () => {
    await actions.setContent(fixtureHtml);

    await actions.fill("#name", "Ada");
    assert.equal(await page.locator("#name").inputValue(), "Ada");
    await actions.selectText("#name");
    await actions.clear("#name");
    assert.equal(await page.locator("#name").inputValue(), "");

    await actions.click("#btn");
    assert.equal(await page.locator("#status").textContent(), "clicked");

    const buttonBox = await page.locator("#btn").boundingBox();
    assert.ok(buttonBox);
    await actions.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    assert.equal(await page.locator("#status").textContent(), "clicked");
    await actions.click({ x: buttonBox.x + 4, y: buttonBox.y + 4 });
    await actions.click("#btn", { position: { x: 2, y: 2 } });
    await actions.hover(buttonBox.x, buttonBox.y);
    await actions.tap({ x: buttonBox.x + 1, y: buttonBox.y + 1 });
    await actions.dblclick("#dbl");
    assert.equal(await page.locator("#status").textContent(), "dblclicked");

    await actions.check("#agree");
    assert.equal(await page.locator("#agree").isChecked(), true);
    await actions.uncheck("#agree");
    assert.equal(await page.locator("#agree").isChecked(), false);
    await actions.setChecked("#agree", true);
    assert.equal(await page.locator("#agree").isChecked(), true);

    await actions.selectOption("#color", "blue");
    assert.equal(await page.locator("#color").inputValue(), "blue");

    await actions.hover("#btn");
    await actions.focus("#name");
    await actions.blur("#name");
    await actions.press("#name", "Tab");
    await actions.pressSequentially("#typed", "hi");
    await actions.type("#typed", "!");
    assert.equal(await page.locator("#typed").inputValue(), "hi!");

    await actions.scrollIntoViewIfNeeded("#bottom");
    await actions.dispatchEvent("#btn", "click");
    await actions.highlight("#btn");

    const uploadPath = path.join(os.tmpdir(), "playwright-upload.txt");
    await fs.writeFile(uploadPath, "upload", "utf8");
    await actions.setInputFiles("#file", uploadPath);

    await actions.keyboard.press("Escape");
    await actions.mouse.move(5, 5);
    await actions.mouse.click(8, 8);
    await actions.touchscreen.tap(10, 10);
    await actions.tap("#btn");

    const shot = await actions.screenshot();
    assert.ok(shot.length > 0);

    const processedFiles = await fs.readdir(PROCESSED_DIR);
    assert.ok(processedFiles.some((file) => file.endsWith("-click.webp")));
    assert.ok(processedFiles.some((file) => file.endsWith("-fill.webp")));

    const response = await actions.goto("https://example.com", { waitUntil: "domcontentloaded" });
    assert.ok(response);
    await actions.reload({ waitUntil: "domcontentloaded" });
    assert.equal(page.url(), "https://example.com/");
  });
});
