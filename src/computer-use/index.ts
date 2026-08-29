import { createGeminiInteractionClient } from "./client.js";
import { parseAgentTask } from "./cli.js";
import { runComputerUseLoop } from "./loop.js";
import { confirmSafetyInTerminal } from "./safety.js";
import { defaultSystemPromptVars, loadSystemPrompt } from "./system-prompt.js";
import { AgentRunError, type IntentListener, type SafetyConfirmer } from "./types.js";
import { createProcessedScreenshotSaver } from "../playwright/processed.js";
import {
  BROWSER_SESSION_RESET_MESSAGE,
  createBrowserSession,
  type BrowserSession,
} from "../playwright/session.js";
import { loadConfig, requireGeminiApiKey, type AppConfig } from "../shared/config.js";
import { type TokenUsage } from "../shared/cost.js";
import { logger } from "../shared/logger.js";
import { isMainModule } from "../shared/main-module.js";

export { AgentRunError, BROWSER_SESSION_RESET_MESSAGE };

export interface AgentRunResult {
  readonly text: string;
  readonly sessionReset: boolean;
  readonly usage: TokenUsage;
}

const agentSession = createBrowserSession();
let shuttingDown = false;

export async function closeAgentSession(): Promise<void> {
  await agentSession.close();
}

async function shutdown(exitCode: number, reason: string): Promise<never> {
  if (shuttingDown) {
    process.exit(exitCode);
  }

  shuttingDown = true;
  logger.info(reason);
  await closeAgentSession();
  process.exit(exitCode);
}

export interface AgentRunExtras {
  readonly onIntent?: IntentListener;
  readonly signal?: AbortSignal;
  readonly confirmSafety?: SafetyConfirmer;
}

export async function runAgent(
  task: string,
  config: AppConfig = loadConfig(),
  confirmSafety: SafetyConfirmer = confirmSafetyInTerminal,
  session: BrowserSession = agentSession,
  model = config.geminiModel,
  extras: AgentRunExtras = {},
): Promise<AgentRunResult> {
  requireGeminiApiKey(config);

  logger.info(
    `Computer-use model=${model} thinking=${config.geminiThinkingLevel}` +
      (config.geminiSeed !== undefined ? ` seed=${config.geminiSeed}` : ""),
  );
  const { page, sessionReset } = await session.ensurePage(config);

  if (sessionReset) {
    logger.info(BROWSER_SESSION_RESET_MESSAGE);
  }

  const systemInstruction = await loadSystemPrompt(
    defaultSystemPromptVars(config.viewportWidth, config.viewportHeight),
  );

  const result = await runComputerUseLoop(
    {
      client: createGeminiInteractionClient(config, model, systemInstruction),
      page,
      saveScreenshot: createProcessedScreenshotSaver(page, config.processedDir),
      confirmSafety: extras.confirmSafety ?? confirmSafety,
      screenWidth: config.viewportWidth,
      screenHeight: config.viewportHeight,
      maxTurns: config.agentMaxTurns,
      onIntent: extras.onIntent,
      signal: extras.signal,
    },
    task,
  );

  logger.info(`Computer-use status=${result.status} turns=${result.turns}`);
  return { text: result.finalText, sessionReset, usage: result.usage };
}

function registerShutdownHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(0, `Received ${signal}, shutting down`);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

async function waitUntilStopped(): Promise<void> {
  logger.info("Task finished. Browser stays open until Ctrl+C");
  await new Promise<void>(() => {
    // Shutdown handlers call process.exit.
  });
}

async function main(): Promise<void> {
  registerShutdownHandlers();
  const task = parseAgentTask(process.argv);
  await runAgent(task);
  await waitUntilStopped();
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error("Fatal error", error);
    void shutdown(1, "Exiting after fatal error");
  });
}
