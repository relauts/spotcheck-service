import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
export const DEFAULT_AGENT_MAX_TURNS = 15;
export const DEFAULT_SERVICE_PORT = 18732;
export const DEFAULT_MAX_SAVED_RUNS = 2;
export const GEMINI_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];
export const DEFAULT_GEMINI_THINKING_LEVEL: GeminiThinkingLevel = "minimal";
export const CONFIG_FILE_NAME = "relauts-spotcheck-service-config.json";

export const GEMINI_SAFETY_POLICIES = [
  "financial_transactions",
  "sensitive_data_modification",
  "communication_tool",
  "account_creation",
  "data_modification",
  "user_consent_management",
  "legal_terms_and_agreements",
] as const;
export type GeminiSafetyPolicy = (typeof GEMINI_SAFETY_POLICIES)[number];

export interface AppConfig {
  readonly targetUrl: string;
  readonly navigationTimeoutMs: number;
  readonly headless: boolean;
  readonly chromiumSandbox: boolean;
  readonly webPort: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly geminiApiKey: string | undefined;
  readonly geminiModel: string;
  readonly geminiThinkingLevel: GeminiThinkingLevel;
  readonly geminiSeed: number | undefined;
  readonly agentMaxTurns: number;
  readonly geminiDisabledSafetyPolicies: readonly GeminiSafetyPolicy[];
  readonly apiToken: string | undefined;
  readonly corsOrigins: readonly string[];
  readonly savedDir: string;
  readonly processedDir: string;
  readonly historyDir: string;
  readonly maxSavedRuns: number;
  readonly installationId: string | undefined;
  readonly telemetryUrl: string | undefined;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }

  throw new Error(`Invalid boolean value: "${String(value)}"`);
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: "${String(value)}"`);
  }

  return parsed;
}

function parseHttpUrl(value: unknown): string {
  const raw = typeof value === "string" ? value : "https://example.com";
  return parseRequiredHttpUrl(raw);
}

function parseRequiredHttpUrl(raw: string): string {
  const url = new URL(raw);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL must use http or https: "${raw}"`);
  }

  return url.toString();
}

function parseOptionalHttpUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`URL must use http or https: "${String(value)}"`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return parseRequiredHttpUrl(trimmed);
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalSeed(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" && !value.trim()) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid seed: "${String(value)}"`);
  }

  return parsed;
}

function parseThinkingLevel(
  value: unknown,
  fallback: GeminiThinkingLevel,
): GeminiThinkingLevel {
  if (value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if ((GEMINI_THINKING_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as GeminiThinkingLevel;
  }

  throw new Error(
    `Invalid thinking level: "${String(value)}". Use ${GEMINI_THINKING_LEVELS.join(", ")}`,
  );
}

/**
 * Runs target QA environments, so every predefined safety policy is disabled by
 * default and Gemini stops gating actions such as checkout clicks. Omit the
 * field to keep that default, set it to "none" to keep all policies active, or
 * pass a list to disable only those. Gemini may still return require_confirmation
 * regardless, so callers must keep handling safety decisions.
 */
function parseSafetyPolicies(value: unknown): readonly GeminiSafetyPolicy[] {
  if (value === undefined || value === null) {
    return GEMINI_SAFETY_POLICIES;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return GEMINI_SAFETY_POLICIES;
    }

    return value.map((entry) => parseSafetyPolicy(String(entry)));
  }

  if (typeof value !== "string") {
    throw new Error(
      `Invalid safety policies. Use ${GEMINI_SAFETY_POLICIES.join(", ")}, or none`,
    );
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return GEMINI_SAFETY_POLICIES;
  }

  if (trimmed.toLowerCase() === "none") {
    return [];
  }

  return trimmed.split(",").map((entry) => parseSafetyPolicy(entry));
}

function parseSafetyPolicy(entry: string): GeminiSafetyPolicy {
  const normalized = entry.trim().toLowerCase();
  if (!(GEMINI_SAFETY_POLICIES as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid safety policy: "${entry.trim()}". Use ${GEMINI_SAFETY_POLICIES.join(", ")}, or none`,
    );
  }

  return normalized as GeminiSafetyPolicy;
}

function parseCorsOrigins(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }

  const entries = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : typeof value === "string"
      ? value.split(",")
      : null;

  if (!entries) {
    throw new Error(`Invalid CORS origins: "${String(value)}"`);
  }

  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseDirPath(value: unknown, fallbackRelative: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallbackRelative;
  return path.resolve(process.cwd(), raw);
}

function pick(source: Record<string, unknown>, camel: string, envKey: string): unknown {
  if (Object.prototype.hasOwnProperty.call(source, camel)) {
    return source[camel];
  }

  return source[envKey];
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function resolveConfigFilePath(): string {
  const fromCwd = path.resolve(process.cwd(), CONFIG_FILE_NAME);
  if (fs.existsSync(fromCwd)) {
    return fromCwd;
  }

  return path.resolve(resolveRepoRoot(), "..", CONFIG_FILE_NAME);
}

export function readConfigFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid config JSON (${filePath}): ${message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must be a JSON object: ${filePath}`);
  }

  return parsed as Record<string, unknown>;
}

export function loadConfig(source?: Record<string, unknown>): AppConfig {
  const raw = source ?? readConfigFile(resolveConfigFilePath());

  return {
    targetUrl: parseHttpUrl(pick(raw, "targetUrl", "TARGET_URL")),
    navigationTimeoutMs: parsePositiveInt(pick(raw, "navigationTimeoutMs", "NAVIGATION_TIMEOUT_MS"), 30_000),
    headless: parseBoolean(pick(raw, "headless", "HEADLESS"), true),
    chromiumSandbox: parseBoolean(pick(raw, "chromiumSandbox", "CHROMIUM_SANDBOX"), true),
    webPort: parsePositiveInt(pick(raw, "port", "PORT"), DEFAULT_SERVICE_PORT),
    viewportWidth: parsePositiveInt(pick(raw, "viewportWidth", "VIEWPORT_WIDTH"), 1024),
    viewportHeight: parsePositiveInt(pick(raw, "viewportHeight", "VIEWPORT_HEIGHT"), 768),
    geminiApiKey: parseOptionalString(pick(raw, "geminiApiKey", "GEMINI_API_KEY")),
    geminiModel: parseOptionalString(pick(raw, "geminiModel", "GEMINI_MODEL")) ?? DEFAULT_GEMINI_MODEL,
    geminiThinkingLevel: parseThinkingLevel(
      pick(raw, "geminiThinkingLevel", "GEMINI_THINKING_LEVEL"),
      DEFAULT_GEMINI_THINKING_LEVEL,
    ),
    geminiSeed: parseOptionalSeed(pick(raw, "seed", "SEED")),
    agentMaxTurns: parsePositiveInt(pick(raw, "agentMaxTurns", "AGENT_MAX_TURNS"), DEFAULT_AGENT_MAX_TURNS),
    geminiDisabledSafetyPolicies: parseSafetyPolicies(
      pick(raw, "geminiDisabledSafetyPolicies", "GEMINI_DISABLED_SAFETY_POLICIES"),
    ),
    apiToken: parseOptionalString(pick(raw, "apiToken", "API_TOKEN")),
    corsOrigins: parseCorsOrigins(pick(raw, "corsOrigins", "CORS_ORIGINS")),
    savedDir: parseDirPath(pick(raw, "savedDir", "SAVED_DIR"), "saved"),
    processedDir: parseDirPath(pick(raw, "processedDir", "PROCESSED_DIR"), "processed"),
    historyDir: parseDirPath(pick(raw, "historyDir", "HISTORY_DIR"), "history"),
    maxSavedRuns: parsePositiveInt(pick(raw, "maxSavedRuns", "MAX_SAVED_RUNS"), DEFAULT_MAX_SAVED_RUNS),
    installationId: parseOptionalString(pick(raw, "installationId", "INSTALLATION_ID")),
    telemetryUrl: parseOptionalHttpUrl(pick(raw, "telemetryUrl", "TELEMETRY_URL")),
  };
}

export function requireGeminiApiKey(config: AppConfig): string {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  return config.geminiApiKey;
}

export function requireApiToken(config: AppConfig): string {
  if (!config.apiToken) {
    throw new Error("API_TOKEN is required");
  }

  return config.apiToken;
}
