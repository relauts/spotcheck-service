import type { Browser, Page } from "playwright";
import type { AppConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { closeBrowser, launchLightChromium } from "./chromium.js";
import { PROCESSED_DIR, createProcessedScreenshotSaver } from "./processed.js";

export const BROWSER_SESSION_RESET_MESSAGE = "Browser session was reset. Started a new browser.";

export interface PageEnsureResult {
  readonly page: Page;
  readonly sessionReset: boolean;
}

export interface SessionStatus {
  readonly open: boolean;
  readonly url: string;
}

export class BrowserClosedError extends Error {
  constructor(message = "Browser is closed") {
    super(message);
    this.name = "BrowserClosedError";
  }
}

export interface BrowserSession {
  isOpen(): boolean;
  getStatus(): SessionStatus;
  ensurePage(config: AppConfig): Promise<PageEnsureResult>;
  close(): Promise<void>;
  goBack(): Promise<SessionStatus>;
  goForward(): Promise<SessionStatus>;
  reload(): Promise<SessionStatus>;
}

export interface BrowserSessionDeps {
  launch?(config: AppConfig): Promise<Browser>;
  screenshotDir?: string;
}

export function createBrowserSession(deps: BrowserSessionDeps = {}): BrowserSession {
  const launch = deps.launch ?? launchLightChromium;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let saveScreenshot: ((actionName: string) => Promise<string>) | undefined;
  let everOpened = false;
  let needsResetNotice = false;
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function isLive(): boolean {
    try {
      return Boolean(browser?.isConnected() && page && !page.isClosed());
    } catch {
      return false;
    }
  }

  function attachDisconnectHandler(current: Browser): void {
    current.on("disconnected", () => {
      if (browser !== current) {
        return;
      }

      browser = undefined;
      page = undefined;
      saveScreenshot = undefined;
      needsResetNotice = true;
      logger.info("Chromium disconnected");
    });
  }

  async function drop(): Promise<void> {
    const current = browser;
    browser = undefined;
    page = undefined;
    saveScreenshot = undefined;
    await closeBrowser(current);
  }

  function currentStatus(): SessionStatus {
    if (!isLive() || !page) {
      return { open: false, url: "" };
    }

    try {
      return { open: true, url: page.url() };
    } catch {
      return { open: false, url: "" };
    }
  }

  function requirePage(): Page {
    if (!isLive() || !page) {
      throw new BrowserClosedError();
    }

    return page;
  }

  async function capture(actionName: string, current: Page): Promise<void> {
    const saver = saveScreenshot ?? createProcessedScreenshotSaver(current, deps.screenshotDir ?? PROCESSED_DIR);
    await saver(actionName);
  }

  async function goBackLocked(): Promise<SessionStatus> {
    const current = requirePage();
    logger.info("Browser chrome: back");
    await current.goBack();
    await capture("back", current);
    return currentStatus();
  }

  async function goForwardLocked(): Promise<SessionStatus> {
    const current = requirePage();
    logger.info("Browser chrome: forward");
    await current.goForward();
    await capture("forward", current);
    return currentStatus();
  }

  async function reloadLocked(): Promise<SessionStatus> {
    const current = requirePage();
    logger.info("Browser chrome: reload");
    await current.reload();
    await capture("reload", current);
    return currentStatus();
  }

  async function ensurePageLocked(config: AppConfig): Promise<PageEnsureResult> {
    if (isLive() && page) {
      logger.info("Reusing open Chromium page");
      return { page, sessionReset: false };
    }

    const sessionReset = needsResetNotice || everOpened;
    if (browser || page) {
      logger.info("Chromium session was lost; launching a new browser");
    }

    await drop();

    logger.info(
      `Launching Chromium for computer-use (headless=${config.headless}, viewport=${config.viewportWidth}x${config.viewportHeight})`,
    );
    const launched = await launch(config);
    attachDisconnectHandler(launched);
    browser = launched;

    const nextPage = await launched.newPage({
      viewport: {
        width: config.viewportWidth,
        height: config.viewportHeight,
      },
    });
    nextPage.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    try {
      logger.info(`Navigating to ${config.targetUrl}`);
      await nextPage.goto(config.targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      });
    } catch (error: unknown) {
      await drop();
      throw error;
    }

    page = nextPage;
    saveScreenshot = createProcessedScreenshotSaver(nextPage, deps.screenshotDir ?? PROCESSED_DIR);
    everOpened = true;
    needsResetNotice = false;
    return { page, sessionReset };
  }

  async function closeLocked(): Promise<void> {
    if (everOpened) {
      needsResetNotice = true;
    }

    if (!browser && !page) {
      return;
    }

    logger.info("Closing Chromium session");
    await drop();
  }

  return {
    isOpen(): boolean {
      return isLive();
    },
    getStatus(): SessionStatus {
      return currentStatus();
    },
    ensurePage(config: AppConfig): Promise<PageEnsureResult> {
      return enqueue(() => ensurePageLocked(config));
    },
    close(): Promise<void> {
      return enqueue(() => closeLocked());
    },
    goBack(): Promise<SessionStatus> {
      return enqueue(() => goBackLocked());
    },
    goForward(): Promise<SessionStatus> {
      return enqueue(() => goForwardLocked());
    },
    reload(): Promise<SessionStatus> {
      return enqueue(() => reloadLocked());
    },
  };
}
