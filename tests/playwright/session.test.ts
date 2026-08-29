import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import type { AppConfig } from "../../src/shared/config.js";
import { BrowserClosedError, createBrowserSession } from "../../src/playwright/session.js";

const config: AppConfig = {
  targetUrl: "https://example.com/",
  navigationTimeoutMs: 30_000,
  headless: true,
  chromiumSandbox: true,
  webPort: 3000,
  viewportWidth: 1024,
  viewportHeight: 768,
  geminiApiKey: undefined,
  geminiModel: "gemini-3.6-flash",
  geminiThinkingLevel: "minimal",
  geminiSeed: undefined,
  agentMaxTurns: 15,
};

class FakePage {
  closed = false;
  gotos: string[] = [];
  viewport: { width: number; height: number } | undefined;
  currentUrl = "about:blank";
  history: string[] = ["about:blank"];
  historyIndex = 0;
  reloadCount = 0;

  isClosed(): boolean {
    return this.closed;
  }

  url(): string {
    return this.currentUrl;
  }

  setDefaultNavigationTimeout(_timeout: number): void {}

  async goto(url: string): Promise<null> {
    this.gotos.push(url);
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    this.currentUrl = url;
    return null;
  }

  async goBack(): Promise<null> {
    if (this.historyIndex <= 0) {
      return null;
    }
    this.historyIndex -= 1;
    this.currentUrl = this.history[this.historyIndex] ?? this.currentUrl;
    return null;
  }

  async goForward(): Promise<null> {
    if (this.historyIndex >= this.history.length - 1) {
      return null;
    }
    this.historyIndex += 1;
    this.currentUrl = this.history[this.historyIndex] ?? this.currentUrl;
    return null;
  }

  async reload(): Promise<null> {
    this.reloadCount += 1;
    return null;
  }

  async screenshot(_options?: { path?: string; type?: string }): Promise<Buffer> {
    return Buffer.from([]);
  }

  async waitForLoadState(_state?: string, _options?: { timeout?: number }): Promise<void> {}

  async evaluate(_pageFunction: unknown, _arg?: unknown): Promise<void> {}
}

class FakeBrowser {
  connected = true;
  pages: FakePage[] = [];
  disconnectListeners: Array<() => void> = [];
  closeCount = 0;

  isConnected(): boolean {
    return this.connected;
  }

  async newPage(options: { viewport: { width: number; height: number } }): Promise<FakePage> {
    const page = new FakePage();
    page.viewport = options.viewport;
    this.pages.push(page);
    return page;
  }

  on(event: "disconnected", listener: () => void): this {
    if (event === "disconnected") {
      this.disconnectListeners.push(listener);
    }
    return this;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.connected = false;
    for (const page of this.pages) {
      page.closed = true;
    }
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }

  disconnect(): void {
    this.connected = false;
    for (const page of this.pages) {
      page.closed = true;
    }
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

function asBrowser(browser: FakeBrowser): Browser {
  return browser as unknown as Browser;
}

describe("createBrowserSession", () => {
  it("is closed until the first page is created", () => {
    const session = createBrowserSession({
      launch: async () => asBrowser(new FakeBrowser()),
    });

    assert.equal(session.isOpen(), false);
  });

  it("launches Chromium and opens TARGET_URL on first ensurePage", async () => {
    const browsers: FakeBrowser[] = [];
    const session = createBrowserSession({
      launch: async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return asBrowser(browser);
      },
    });

    const first = await session.ensurePage(config);

    assert.equal(session.isOpen(), true);
    assert.equal(first.sessionReset, false);
    assert.equal(browsers.length, 1);
    assert.deepEqual(browsers[0]?.pages[0]?.gotos, ["https://example.com/"]);
    assert.deepEqual(browsers[0]?.pages[0]?.viewport, { width: 1024, height: 768 });
  });

  it("reuses the same page and does not navigate again", async () => {
    const browsers: FakeBrowser[] = [];
    const session = createBrowserSession({
      launch: async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return asBrowser(browser);
      },
    });

    const first = await session.ensurePage(config);
    const second = await session.ensurePage(config);

    assert.equal(browsers.length, 1);
    assert.equal(second.sessionReset, false);
    assert.equal(first.page, second.page);
    assert.deepEqual(browsers[0]?.pages[0]?.gotos, ["https://example.com/"]);
  });

  it("relaunches and reports sessionReset after close", async () => {
    const browsers: FakeBrowser[] = [];
    const session = createBrowserSession({
      launch: async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return asBrowser(browser);
      },
    });

    await session.ensurePage(config);
    await session.close();

    assert.equal(session.isOpen(), false);
    assert.equal(browsers[0]?.closeCount, 1);

    const next = await session.ensurePage(config);

    assert.equal(next.sessionReset, true);
    assert.equal(browsers.length, 2);
    assert.deepEqual(browsers[1]?.pages[0]?.gotos, ["https://example.com/"]);
  });

  it("relaunches and reports sessionReset after disconnect", async () => {
    const browsers: FakeBrowser[] = [];
    const session = createBrowserSession({
      launch: async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return asBrowser(browser);
      },
    });

    await session.ensurePage(config);
    browsers[0]?.disconnect();

    assert.equal(session.isOpen(), false);

    const next = await session.ensurePage(config);

    assert.equal(next.sessionReset, true);
    assert.equal(browsers.length, 2);
  });

  it("does not report sessionReset after a failed first launch", async () => {
    let attempts = 0;
    const session = createBrowserSession({
      launch: async () => {
        attempts += 1;
        const browser = new FakeBrowser();
        if (attempts === 1) {
          browser.newPage = async () => {
            const page = new FakePage();
            page.goto = async () => {
              throw new Error("nav failed");
            };
            browser.pages.push(page);
            return page;
          };
        }
        return asBrowser(browser);
      },
    });

    await assert.rejects(() => session.ensurePage(config), /nav failed/);
    assert.equal(session.isOpen(), false);

    const next = await session.ensurePage(config);
    assert.equal(next.sessionReset, false);
    assert.equal(attempts, 2);
  });

  it("serializes concurrent ensurePage calls so only one browser launches", async () => {
    let launches = 0;
    const session = createBrowserSession({
      launch: async () => {
        launches += 1;
        await Promise.resolve();
        return asBrowser(new FakeBrowser());
      },
    });

    const [first, second] = await Promise.all([session.ensurePage(config), session.ensurePage(config)]);

    assert.equal(launches, 1);
    assert.equal(first.page, second.page);
    assert.equal(first.sessionReset, false);
    assert.equal(second.sessionReset, false);
  });

  it("close is a no-op when nothing was opened", async () => {
    const session = createBrowserSession({
      launch: async () => asBrowser(new FakeBrowser()),
    });

    await assert.doesNotReject(() => session.close());
    assert.equal(session.isOpen(), false);

    const first = await session.ensurePage(config);
    assert.equal(first.sessionReset, false);
  });

  it("exposes the current url and chrome navigation", async () => {
    const browsers: FakeBrowser[] = [];
    const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-shots-"));
    const session = createBrowserSession({
      screenshotDir,
      launch: async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return asBrowser(browser);
      },
    });

    try {
      assert.deepEqual(session.getStatus(), { open: false, url: "" });
      await assert.rejects(() => session.goBack(), BrowserClosedError);

      await session.ensurePage(config);
      const page = browsers[0]?.pages[0];
      assert.deepEqual(session.getStatus(), { open: true, url: "https://example.com/" });

      await page?.goto("https://example.com/next");
      assert.equal(session.getStatus().url, "https://example.com/next");

      assert.deepEqual(await session.goBack(), { open: true, url: "https://example.com/" });
      assert.deepEqual(await session.goForward(), { open: true, url: "https://example.com/next" });
      assert.deepEqual(await session.reload(), { open: true, url: "https://example.com/next" });
      assert.equal(page?.reloadCount, 1);

      await session.close();
      assert.deepEqual(session.getStatus(), { open: false, url: "" });
      await assert.rejects(() => session.reload(), BrowserClosedError);
    } finally {
      await fs.rm(screenshotDir, { recursive: true, force: true });
    }
  });
});

describe("createBrowserSession with Chromium", () => {
  it("reuses one live page until close", { timeout: 60_000 }, async () => {
    const session = createBrowserSession();

    try {
      const first = await session.ensurePage(config);
      const second = await session.ensurePage(config);

      assert.equal(second.sessionReset, false);
      assert.equal(first.page, second.page);
      assert.match((first.page as Page).url(), /example\.com/);
      assert.equal(session.getStatus().open, true);
      assert.match(session.getStatus().url, /example\.com/);
    } finally {
      await session.close();
    }

    assert.equal(session.isOpen(), false);
  });
});
