import { chromium, type Browser, type LaunchOptions } from "playwright";
import type { AppConfig } from "../shared/config.js";

/**
 * Playwright Chromium defaults only. Extra flags (--no-sandbox, --no-zygote,
 * GPU off, site-isolation off) are unsafe or break launch/screenshots on some OSes.
 * Set CHROMIUM_SANDBOX=false only in Linux containers that run as root.
 */
export function getChromiumLaunchOptions(config: AppConfig): LaunchOptions {
  return {
    headless: config.headless,
    chromiumSandbox: config.chromiumSandbox,
  };
}

export async function launchLightChromium(config: AppConfig): Promise<Browser> {
  return chromium.launch(getChromiumLaunchOptions(config));
}

export async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) {
    return;
  }

  try {
    await browser.close();
  } catch {
    // Browser may already be closed during shutdown.
  }
}
