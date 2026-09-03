import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

export const PROCESSED_DIR = path.resolve(process.cwd(), "processed");
export const SAVED_RUNS_SUBDIR = "saved-runs";

export async function getLatestWebpPath(directory = PROCESSED_DIR): Promise<string | undefined> {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const webpFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".webp"));
  if (webpFiles.length === 0) {
    return undefined;
  }

  const ranked = await Promise.all(
    webpFiles.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const stats = await fs.stat(filePath);
      return { filePath, mtimeMs: stats.mtimeMs, name: entry.name };
    }),
  );

  ranked.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }

    return right.name.localeCompare(left.name);
  });

  return ranked[0]?.filePath;
}

async function latestWebpFrom(filePaths: string[]): Promise<string | undefined> {
  if (filePaths.length === 0) {
    return undefined;
  }

  const ranked = await Promise.all(
    filePaths.map(async (filePath) => {
      const stats = await fs.stat(filePath);
      return { filePath, mtimeMs: stats.mtimeMs, name: path.basename(filePath) };
    }),
  );

  ranked.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }

    return right.name.localeCompare(left.name);
  });

  return ranked[0]?.filePath;
}

function isSafeEntryName(name: string): boolean {
  return name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

export function savedRunScreenshotStem(historyFile: string): string {
  return historyFile.replace(/\.json$/i, "");
}

export async function getSavedRunScreenshotRelPath(
  processedDir: string,
  historyFile: string,
): Promise<string> {
  const stem = savedRunScreenshotStem(historyFile);
  const runDir = path.join(processedDir, SAVED_RUNS_SUBDIR, stem);
  let entries: Dirent[];

  try {
    entries = await fs.readdir(runDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!isSafeEntryName(entry.name)) {
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".webp")) {
      files.push(path.join(runDir, entry.name));
      continue;
    }

    if (entry.isDirectory()) {
      const nested = await getLatestWebpPath(path.join(runDir, entry.name));
      if (nested) {
        files.push(nested);
      }
    }
  }

  const latest = await latestWebpFrom(files);
  if (!latest) {
    return "";
  }

  const rel = path.relative(runDir, latest).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return "";
  }

  return `${stem}/${rel}`;
}

function sanitizePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "id";
  }

  return cleaned;
}

export function savedRunQuestionFolder(sequence: number, id: string): string {
  return `${String(sequence).padStart(4, "0")}-${sanitizePathSegment(id)}`;
}

export function savedRunItemScreenshotDir(
  processedDir: string,
  historyFile: string,
  sequence: number,
  id: string,
): string {
  return path.join(
    processedDir,
    SAVED_RUNS_SUBDIR,
    savedRunScreenshotStem(historyFile),
    savedRunQuestionFolder(sequence, id),
  );
}

export async function getSavedRunItemScreenshotRelPaths(
  processedDir: string,
  historyFile: string,
  sequence: number,
  id: string,
): Promise<string[]> {
  const stem = savedRunScreenshotStem(historyFile);
  const folder = savedRunQuestionFolder(sequence, id);
  const dir = savedRunItemScreenshotDir(processedDir, historyFile, sequence, id);
  let entries: Dirent[];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        isSafeEntryName(entry.name) &&
        entry.name.toLowerCase().endsWith(".webp"),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `${stem}/${folder}/${name}`);
}

const SCREENSHOT_LOAD_TIMEOUT_MS = 5_000;
const SCREENSHOT_PAINT_SETTLE_MS = 200;

function sanitizeActionName(actionName: string): string {
  return actionName.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ignoreFailure(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Still capture whatever is on screen.
  }
}

// Playwright invokes a real Function object with `arg`, but only `eval`s a string
// primitive as an expression (ignoring `arg`). This project has no DOM lib, so the
// browser-side body is built via `new Function` to stay a real callable without
// requiring DOM types for type-checking.
const waitForPaintSettleInBrowser = new Function(
  "settleMs",
  `return new Promise((resolve) => {
    const finish = () => {
      void document.documentElement.offsetHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.setTimeout(resolve, settleMs);
        });
      });
    };
    if (document.readyState === "complete") {
      finish();
      return;
    }
    window.addEventListener("load", finish, { once: true });
    window.setTimeout(finish, 1000);
  });`,
) as (settleMs: number) => Promise<void>;

export async function waitForScreenshotReady(page: Page): Promise<void> {
  if (page.isClosed()) {
    return;
  }

  await ignoreFailure(() => page.waitForLoadState("load", { timeout: SCREENSHOT_LOAD_TIMEOUT_MS }));

  await ignoreFailure(() => page.evaluate(waitForPaintSettleInBrowser, SCREENSHOT_PAINT_SETTLE_MS));
}

export function createProcessedScreenshotSaver(page: Page, directory = PROCESSED_DIR) {
  let sequence = 0;

  return async function saveProcessedScreenshot(actionName: string): Promise<string> {
    sequence += 1;
    await fs.mkdir(directory, { recursive: true });

    const fileName = `${timestamp()}-${String(sequence).padStart(4, "0")}-${sanitizeActionName(actionName)}.webp`;
    const filePath = path.join(directory, fileName);
    await waitForScreenshotReady(page);
    await page.screenshot({ path: filePath, type: "webp" });
    return filePath;
  };
}
