import fs from "node:fs/promises";
import path from "node:path";
import { SavedNameError, SavedNotFoundError, normalizeSavedFileName, type SavedPromptItem } from "./saved.js";

export const HISTORY_DIR = path.resolve(process.cwd(), "history");

export const HISTORY_RUN_STATUSES = ["running", "done", "error", "stopped"] as const;
export type HistoryRunStatus = (typeof HISTORY_RUN_STATUSES)[number];
export type HistoryItemStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface HistoryRunSummary {
  readonly historyFile: string;
  readonly status: HistoryRunStatus;
}

export interface HistoryDetailItem {
  readonly sequence: number;
  readonly prompt: string;
  readonly model: string;
  readonly resultText?: string;
  readonly screenshots: readonly string[];
}

function isHistoryRunStatus(value: unknown): value is HistoryRunStatus {
  return typeof value === "string" && (HISTORY_RUN_STATUSES as readonly string[]).includes(value);
}

export interface HistoryItem {
  readonly sequence: number;
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly status: HistoryItemStatus;
  readonly resultText?: string;
  readonly costUsd?: number;
  readonly error?: string;
}

export interface HistoryDocument {
  readonly fileName: string;
  readonly status: HistoryRunStatus;
  readonly current: number;
  readonly total: number;
  readonly items: readonly HistoryItem[];
}

export function makeHistoryFileName(savedFileName: string, now = new Date()): string {
  const name = normalizeSavedFileName(savedFileName);
  const stem = name.slice(0, -".json".length);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stem}-${stamp}.json`;
}

export function createHistoryDocument(
  savedFileName: string,
  items: readonly SavedPromptItem[],
): HistoryDocument {
  return {
    fileName: normalizeSavedFileName(savedFileName),
    status: "running",
    current: 0,
    total: items.length,
    items: items.map((item) => ({
      sequence: item.sequence,
      id: item.id,
      prompt: item.prompt,
      model: item.model,
      status: "pending",
    })),
  };
}

export function serializeHistoryDetailItem(
  item: HistoryItem,
  screenshots: readonly string[],
): HistoryDetailItem {
  return {
    sequence: item.sequence,
    prompt: item.prompt,
    model: item.model,
    ...(item.resultText ? { resultText: item.resultText } : {}),
    screenshots: [...screenshots],
  };
}

export function serializeHistoryItem(item: HistoryItem): HistoryItem {
  return {
    sequence: item.sequence,
    id: item.id,
    prompt: item.prompt,
    model: item.model,
    status: item.status,
    ...(item.resultText ? { resultText: item.resultText } : {}),
    ...(typeof item.costUsd === "number" ? { costUsd: item.costUsd } : {}),
    ...(item.error ? { error: item.error } : {}),
  };
}

export function serializeHistoryDocument(document: HistoryDocument): HistoryDocument {
  return {
    fileName: document.fileName,
    status: document.status,
    current: document.current,
    total: document.total,
    items: document.items.map(serializeHistoryItem),
  };
}

export async function writeHistoryFile(
  historyFileName: string,
  document: HistoryDocument,
  directory = HISTORY_DIR,
): Promise<string> {
  const name = normalizeSavedFileName(historyFileName);
  await fs.mkdir(directory, { recursive: true });
  const body = `${JSON.stringify(serializeHistoryDocument(document), null, 2)}\n`;
  const filePath = path.join(directory, name);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, body);
  await fs.rename(tempPath, filePath);
  return name;
}

export async function readHistoryFile(
  historyFileName: string,
  directory = HISTORY_DIR,
): Promise<HistoryDocument> {
  const name = normalizeSavedFileName(historyFileName);
  const filePath = path.join(directory, name);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SavedNotFoundError(`History file not found: ${name}`);
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SavedNameError("History file is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SavedNameError("History file must be a JSON object");
  }

  return parsed as HistoryDocument;
}

export interface LatestHistoryMatch {
  readonly historyFile: string;
  readonly document: HistoryDocument;
}

export async function listHistoryRuns(directory = HISTORY_DIR): Promise<HistoryRunSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const ranked: Array<{ historyFile: string; status: HistoryRunStatus; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) {
      continue;
    }

    try {
      const document = await readHistoryFile(name, directory);
      if (!isHistoryRunStatus(document.status)) {
        continue;
      }

      const stats = await fs.stat(path.join(directory, name));
      ranked.push({ historyFile: name, status: document.status, mtimeMs: stats.mtimeMs });
    } catch {
      // Skip unreadable or invalid files.
    }
  }

  ranked.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }

    return right.historyFile.localeCompare(left.historyFile);
  });

  return ranked.map(({ historyFile, status }) => ({ historyFile, status }));
}

export async function findLatestHistory(
  savedFileName: string,
  directory = HISTORY_DIR,
): Promise<LatestHistoryMatch> {
  const wanted = normalizeSavedFileName(savedFileName);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SavedNotFoundError(`History file not found for: ${wanted}`);
    }

    throw error;
  }

  const ranked: Array<{ historyFile: string; document: HistoryDocument; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) {
      continue;
    }

    try {
      const document = await readHistoryFile(name, directory);
      if (normalizeSavedFileName(document.fileName) !== wanted) {
        continue;
      }

      const stats = await fs.stat(path.join(directory, name));
      ranked.push({ historyFile: name, document, mtimeMs: stats.mtimeMs });
    } catch {
      // Skip unreadable or invalid files.
    }
  }

  ranked.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }

    return right.historyFile.localeCompare(left.historyFile);
  });

  const latest = ranked[0];
  if (!latest) {
    throw new SavedNotFoundError(`History file not found for: ${wanted}`);
  }

  return { historyFile: latest.historyFile, document: latest.document };
}
