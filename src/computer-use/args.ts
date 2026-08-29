import { denormalizeX, denormalizeY } from "./coords.js";

export function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }

  return value;
}

export function asNonNegativeNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = asFiniteNumber(value, field);
  if (parsed < 0) {
    throw new Error(`${field} must be >= 0`);
  }

  return parsed;
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  return value;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === 1) {
    return true;
  }

  if (value === "false" || value === 0) {
    return false;
  }

  return fallback;
}

export function asStringList(value: unknown, field: string): string[] {
  if (typeof value === "string") {
    const keys = value
      .split("+")
      .map((key) => key.trim())
      .filter((key) => key.length > 0);
    if (keys.length === 0) {
      throw new Error(`${field} must not be empty`);
    }

    return keys;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const keys = value.map((item) => item.trim()).filter((item) => item.length > 0);
    if (keys.length === 0) {
      throw new Error(`${field} must not be empty`);
    }

    return keys;
  }

  throw new Error(`${field} must be a string list`);
}

export function asPoint(
  args: Record<string, unknown>,
  screenWidth: number,
  screenHeight: number,
): { x: number; y: number } {
  return {
    x: denormalizeX(asFiniteNumber(args.x, "x"), screenWidth),
    y: denormalizeY(asFiniteNumber(args.y, "y"), screenHeight),
  };
}

export function asIntent(args: Record<string, unknown>): string {
  return typeof args.intent === "string" && args.intent.trim() ? args.intent : "N/A";
}

export function formatIntentLabel(name: string, intent: string, failed = false): string {
  const trimmed = intent.trim();
  const hasIntent = trimmed.length > 0 && trimmed !== "N/A";
  const base = hasIntent ? `${name} — ${trimmed}` : name;
  return failed ? `${base} (failed)` : base;
}
