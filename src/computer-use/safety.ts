import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { logger } from "../shared/logger.js";

export interface SafetyDecision {
  readonly decision: string;
  readonly explanation: string;
}

export function readSafetyDecision(args: Record<string, unknown>): SafetyDecision | undefined {
  const raw = args.safety_decision;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as { decision?: unknown; explanation?: unknown };
  return {
    decision: typeof record.decision === "string" ? record.decision : "",
    explanation: typeof record.explanation === "string" ? record.explanation : "",
  };
}

export function isSafetyBlocked(decision: SafetyDecision | undefined): boolean {
  return decision?.decision === "blocked";
}

export function requiresSafetyConfirmation(decision: SafetyDecision | undefined): boolean {
  return decision?.decision === "require_confirmation";
}

/**
 * Fallback confirmer for the web UI when no interactive confirmer is wired up
 * (e.g. tests, or callers that don't pass a per-request confirmer). Auto-approving
 * here is NOT safe for real production traffic; startWebServer always supplies a
 * real popup-backed confirmer per request, see createWebSafetyConfirmer in server.ts.
 */
export async function confirmSafetyForWeb(explanation: string, actionName: string): Promise<boolean> {
  logger.info(
    `Safety confirmation auto-approved (web fallback): ${actionName} - ${explanation || "No explanation provided"}`,
  );
  return true;
}

export async function confirmSafetyInTerminal(explanation: string, actionName: string): Promise<boolean> {
  if (!input.isTTY) {
    logger.error("Safety confirmation required but stdin is not a TTY");
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Safety confirmation required for ${actionName}: ${explanation || "No explanation provided"}\nProceed? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
