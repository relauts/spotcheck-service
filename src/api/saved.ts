import fs from "node:fs/promises";
import path from "node:path";

export const SAVED_DIR = path.resolve(process.cwd(), "saved");
export const CREATE_DEFAULT_FILE = "create-default.json";

export interface SavedPromptItem {
  readonly sequence: number;
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly costUsd?: number;
  readonly resultText?: string;
  readonly sessionReset?: boolean;
  readonly error?: string;
}

export class SavedNameError extends Error {}
export class SavedExistsError extends Error {}
export class SavedNotFoundError extends Error {}

function isSavedPromptItem(value: unknown, requirePrompt: boolean): value is SavedPromptItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const item = value as Record<string, unknown>;
  if (
    typeof item.sequence !== "number" ||
    !Number.isInteger(item.sequence) ||
    item.sequence <= 0 ||
    typeof item.id !== "string" ||
    item.id.trim().length === 0 ||
    typeof item.prompt !== "string" ||
    (requirePrompt && item.prompt.trim().length === 0) ||
    typeof item.model !== "string" ||
    item.model.trim().length === 0
  ) {
    return false;
  }

  if (item.costUsd !== undefined && (typeof item.costUsd !== "number" || !Number.isFinite(item.costUsd))) {
    return false;
  }
  if (item.resultText !== undefined && typeof item.resultText !== "string") {
    return false;
  }
  if (item.sessionReset !== undefined && typeof item.sessionReset !== "boolean") {
    return false;
  }
  if (item.error !== undefined && typeof item.error !== "string") {
    return false;
  }

  return true;
}

export function normalizeSavedFileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new SavedNameError("File name is required");
  }

  const withExt = trimmed.toLowerCase().endsWith(".json") ? `${trimmed.slice(0, -5)}.json` : `${trimmed}.json`;
  if (withExt !== path.basename(withExt) || withExt.includes("..") || withExt === ".json") {
    throw new SavedNameError("File name must not contain a path");
  }

  const stem = withExt.slice(0, -5);
  if (!/^[a-zA-Z0-9._ -]+$/.test(stem) || stem.trim().length === 0) {
    throw new SavedNameError("File name can only use letters, numbers, space, dot, dash, and underscore");
  }

  return withExt;
}

export function isCreateDefaultFileName(fileName: string): boolean {
  return normalizeSavedFileName(fileName).toLowerCase() === CREATE_DEFAULT_FILE;
}

export function uniqueSavedItems(items: readonly SavedPromptItem[]): SavedPromptItem[] {
  const byId = new Map<string, SavedPromptItem>();
  for (const item of items) {
    byId.set(item.id, item);
  }

  return [...byId.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map((item, index) => ({
      sequence: index + 1,
      id: item.id,
      prompt: item.prompt.trim(),
      model: item.model.trim(),
      ...(typeof item.costUsd === "number" ? { costUsd: item.costUsd } : {}),
      ...(item.resultText ? { resultText: item.resultText } : {}),
      ...(item.sessionReset ? { sessionReset: true } : {}),
      ...(item.error ? { error: item.error } : {}),
    }));
}

export function parseSavedItems(value: unknown): SavedPromptItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SavedNameError("items must be a non-empty array");
  }

  if (!value.every((item) => isSavedPromptItem(item, true))) {
    throw new SavedNameError("items has invalid saved prompt entries");
  }

  return uniqueSavedItems(value);
}

export function parseCreateItems(value: unknown): SavedPromptItem[] {
  if (!Array.isArray(value)) {
    throw new SavedNameError("items must be an array");
  }

  if (value.length === 0) {
    return [];
  }

  if (!value.every((item) => isSavedPromptItem(item, false))) {
    throw new SavedNameError("items has invalid saved prompt entries");
  }

  return uniqueSavedItems(value);
}

export async function listSavedFiles(directory = SAVED_DIR): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const jsonNames = names.filter((name) => name.toLowerCase().endsWith(".json"));
  jsonNames.sort((left, right) => left.localeCompare(right));
  return jsonNames;
}

async function writeJsonFile(
  directory: string,
  name: string,
  items: readonly SavedPromptItem[],
  flag: "wx" | "w",
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name), `${JSON.stringify(items, null, 2)}\n`, { flag });
}

export async function writeSavedFile(
  fileName: string,
  items: readonly SavedPromptItem[],
  directory = SAVED_DIR,
): Promise<string> {
  const name = normalizeSavedFileName(fileName);
  if (name.toLowerCase() === CREATE_DEFAULT_FILE) {
    throw new SavedNameError(`${CREATE_DEFAULT_FILE} is reserved`);
  }

  const uniqueItems = uniqueSavedItems(items);
  if (uniqueItems.length === 0) {
    throw new SavedNameError("items must be a non-empty array");
  }

  const existing = await listSavedFiles(directory);
  if (existing.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
    throw new SavedExistsError(`File already exists: ${name}`);
  }

  await writeJsonFile(directory, name, uniqueItems, "wx");
  return name;
}

export async function upsertSavedFile(
  fileName: string,
  items: readonly SavedPromptItem[],
  directory = SAVED_DIR,
): Promise<string> {
  const name = normalizeSavedFileName(fileName);
  await writeJsonFile(directory, name, uniqueSavedItems(items), "w");
  return name;
}

export async function overwriteSavedFile(
  fileName: string,
  items: readonly SavedPromptItem[],
  directory = SAVED_DIR,
): Promise<string> {
  const name = normalizeSavedFileName(fileName);
  if (name.toLowerCase() === CREATE_DEFAULT_FILE) {
    throw new SavedNameError(`${CREATE_DEFAULT_FILE} is reserved`);
  }

  const filePath = path.join(directory, name);
  try {
    await fs.access(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SavedNotFoundError(`Saved file not found: ${name}`);
    }

    throw error;
  }

  const uniqueItems = uniqueSavedItems(items);
  if (uniqueItems.length === 0) {
    throw new SavedNameError("items must be a non-empty array");
  }

  await writeJsonFile(directory, name, uniqueItems, "w");
  return name;
}

export async function deleteSavedFile(fileName: string, directory = SAVED_DIR): Promise<string> {
  const name = normalizeSavedFileName(fileName);
  if (name.toLowerCase() === CREATE_DEFAULT_FILE) {
    throw new SavedNameError(`${CREATE_DEFAULT_FILE} is reserved`);
  }

  try {
    await fs.unlink(path.join(directory, name));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SavedNotFoundError(`Saved file not found: ${name}`);
    }

    throw error;
  }

  return name;
}

export async function ensureCreateDefaultFile(directory = SAVED_DIR): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, CREATE_DEFAULT_FILE);
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonFile(directory, CREATE_DEFAULT_FILE, [], "wx");
  }
}

export async function readSavedFile(
  fileName: string,
  directory = SAVED_DIR,
): Promise<{ fileName: string; items: SavedPromptItem[] }> {
  const name = normalizeSavedFileName(fileName);
  const filePath = path.join(directory, name);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SavedNotFoundError(`Saved file not found: ${name}`);
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SavedNameError("Saved file is not valid JSON");
  }

  const items = name.toLowerCase() === CREATE_DEFAULT_FILE ? parseCreateItems(parsed) : parseSavedItems(parsed);
  return { fileName: name, items };
}
