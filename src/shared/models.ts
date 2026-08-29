import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../files/model.json",
);

export interface ModelEntry {
  readonly provider: string;
  readonly model: string;
  readonly input_price_per_million: number;
  readonly output_price_per_million: number;
  readonly cache_price_per_million: number;
  readonly description: string;
}

function isModelEntry(value: unknown): value is ModelEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.provider === "string" &&
    typeof entry.model === "string" &&
    typeof entry.input_price_per_million === "number" &&
    typeof entry.output_price_per_million === "number" &&
    typeof entry.cache_price_per_million === "number" &&
    typeof entry.description === "string" &&
    entry.model.trim().length > 0
  );
}

export async function loadModels(filePath = MODEL_JSON_PATH): Promise<ModelEntry[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("model.json must be a non-empty array");
  }

  if (!parsed.every(isModelEntry)) {
    throw new Error("model.json has invalid model entries");
  }

  return parsed;
}

export function getModelEntry(model: string, models: readonly ModelEntry[]): ModelEntry {
  const trimmed = model.trim();
  const match = models.find((entry) => entry.model === trimmed);
  if (!match) {
    throw new Error(`Unknown model: ${trimmed}`);
  }

  return match;
}

export function assertAllowedModel(model: string, models: readonly ModelEntry[]): string {
  return getModelEntry(model, models).model;
}
