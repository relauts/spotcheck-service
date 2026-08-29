import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";

export const MIN_AUTOMATION_DURATION_MS = 1_000;
const TELEMETRY_TIMEOUT_MS = 10_000;

export type AutomationReporter = (startedAt: Date, endedAt: Date) => void;

export interface TelemetryPostDeps {
  readonly fetch?: typeof fetch;
  readonly randomUUID?: () => string;
}

export function createAutomationReporter(
  config: Pick<AppConfig, "installationId" | "telemetryUrl">,
  deps: TelemetryPostDeps = {},
): AutomationReporter {
  return (startedAt, endedAt) => {
    void postSuccessfulAutomation(config, startedAt, endedAt, deps);
  };
}

export async function postSuccessfulAutomation(
  config: Pick<AppConfig, "installationId" | "telemetryUrl">,
  startedAt: Date,
  endedAt: Date,
  deps: TelemetryPostDeps = {},
): Promise<void> {
  const installationId = config.installationId;
  const telemetryUrl = config.telemetryUrl;
  if (!installationId || !telemetryUrl) {
    return;
  }

  const durationMs = endedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < MIN_AUTOMATION_DURATION_MS) {
    return;
  }

  const fetchFn = deps.fetch ?? fetch;
  const createId = deps.randomUUID ?? randomUUID;
  const body = {
    eventId: createId(),
    uuid: installationId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };

  try {
    const response = await fetchFn(telemetryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.error(`Telemetry request failed: ${response.status}`);
    }
  } catch (error: unknown) {
    logger.error("Telemetry request failed", error);
  }
}
