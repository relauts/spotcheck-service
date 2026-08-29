import type { Browser } from "playwright";
import { loadConfig, type AppConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { isMainModule } from "../shared/main-module.js";
import { closeBrowser, launchLightChromium } from "./chromium.js";
import { createPageActions } from "./actions.js";

let activeBrowser: Browser | undefined;
let shuttingDown = false;

async function shutdown(exitCode: number, reason: string): Promise<never> {
  if (shuttingDown) {
    process.exit(exitCode);
  }

  shuttingDown = true;
  logger.info(reason);
  await closeBrowser(activeBrowser);
  activeBrowser = undefined;
  process.exit(exitCode);
}

export async function runApp(config: AppConfig = loadConfig()): Promise<string> {
  logger.info(
    `Launching Chromium (headless=${config.headless}, sandbox=${config.chromiumSandbox}, viewport=${config.viewportWidth}x${config.viewportHeight})`,
  );
  activeBrowser = await launchLightChromium(config);

  try {
    const page = await activeBrowser.newPage({
      viewport: {
        width: config.viewportWidth,
        height: config.viewportHeight,
      },
    });
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    const actions = createPageActions(page, config.processedDir);

    logger.info(`Navigating to ${config.targetUrl}`);
    await actions.goto(config.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });

    logger.info("Clicking xpath=//a");
    await actions.click("xpath=//a");

    const loadedUrl = page.url();
    logger.info(`Loaded ${loadedUrl}`);
    return loadedUrl;
  } finally {
    await closeBrowser(activeBrowser);
    activeBrowser = undefined;
    logger.info("Browser closed");
  }
}

function registerShutdownHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(0, `Received ${signal}, shutting down`);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

async function main(): Promise<void> {
  registerShutdownHandlers();
  await runApp();
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error("Fatal error", error);
    void shutdown(1, "Exiting after fatal error");
  });
}
