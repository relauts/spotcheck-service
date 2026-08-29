import { buildFunctionResults, executeFunctionCalls } from "./actions.js";
import { compactOldScreenshots, extractModelText, getFunctionCalls } from "./history.js";
import { logger } from "../shared/logger.js";
import { addUsage, EMPTY_USAGE, type TokenUsage } from "../shared/cost.js";
import { readWebpAsBase64 } from "./screenshot.js";
import {
  AgentRunError,
  type ComputerUsePage,
  type IntentListener,
  type InteractionClient,
  type InteractionStep,
  type SafetyConfirmer,
  type ScreenshotSaver,
  type Sleeper,
} from "./types.js";

export interface AgentLoopDeps {
  client: InteractionClient;
  page: ComputerUsePage;
  saveScreenshot: ScreenshotSaver;
  confirmSafety: SafetyConfirmer;
  screenWidth: number;
  screenHeight: number;
  maxTurns: number;
  sleep?: Sleeper;
  readScreenshot?: (filePath: string) => Promise<string>;
  onIntent?: IntentListener;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  status: "completed" | "max_turns" | "safety_denied";
  turns: number;
  finalText: string;
  usage: TokenUsage;
}

async function screenshotBase64(
  saveScreenshot: ScreenshotSaver,
  actionName: string,
  readScreenshot: (filePath: string) => Promise<string>,
): Promise<string> {
  const filePath = await saveScreenshot(actionName);
  return readScreenshot(filePath);
}

async function throwIfAborted(signal: AbortSignal | undefined, usage: TokenUsage): Promise<void> {
  if (signal?.aborted) {
    throw new AgentRunError("Agent stopped", usage);
  }
}

export async function runComputerUseLoop(
  deps: AgentLoopDeps,
  task: string,
): Promise<AgentLoopResult> {
  const readScreenshot = deps.readScreenshot ?? readWebpAsBase64;
  await throwIfAborted(deps.signal, EMPTY_USAGE);
  const initialImage = await screenshotBase64(deps.saveScreenshot, "start", readScreenshot);

  const history: InteractionStep[] = [
    {
      type: "user_input",
      content: [
        { type: "text", text: task },
        { type: "image", data: initialImage, mime_type: "image/webp" },
      ],
    },
  ];

  let finalText = "";
  let usage = EMPTY_USAGE;

  for (let turn = 1; turn <= deps.maxTurns; turn += 1) {
    await throwIfAborted(deps.signal, usage);
    logger.info(`Computer-use turn ${turn}/${deps.maxTurns}`);

    let interaction;
    try {
      interaction = await deps.client.create([...history]);
      usage = addUsage(usage, interaction.usage ?? EMPTY_USAGE);
    } catch (error: unknown) {
      if (deps.signal?.aborted) {
        throw new AgentRunError("Agent stopped", usage);
      }

      logger.error("Gemini API call failed", error);
      if (error instanceof AgentRunError) {
        throw new AgentRunError(error.message, addUsage(usage, error.usage));
      }

      throw new AgentRunError(error instanceof Error ? error.message : String(error), usage);
    }

    await throwIfAborted(deps.signal, usage);
    history.push(...interaction.steps);
    const calls = getFunctionCalls(interaction.steps);

    if (calls.length === 0) {
      finalText = extractModelText(interaction.steps);
      logger.info(`Agent finished: ${finalText || "(no text)"}`);
      return { status: "completed", turns: turn, finalText, usage };
    }

    let results;
    let terminated;
    let lastScreenshotPath;
    try {
      ({ results, terminated, lastScreenshotPath } = await executeFunctionCalls(calls, {
        page: deps.page,
        screenWidth: deps.screenWidth,
        screenHeight: deps.screenHeight,
        saveScreenshot: deps.saveScreenshot,
        confirmSafety: deps.confirmSafety,
        sleep: deps.sleep,
        onIntent: deps.onIntent,
        signal: deps.signal,
      }));
    } catch (error: unknown) {
      if (error instanceof AgentRunError && error.message === "Agent stopped") {
        throw new AgentRunError("Agent stopped", usage);
      }

      throw error;
    }

    if (terminated) {
      logger.info("Agent stopped after safety denial");
      return { status: "safety_denied", turns: turn, finalText, usage };
    }

    const screenshotPath = lastScreenshotPath ?? (await deps.saveScreenshot("state"));
    const image = await readScreenshot(screenshotPath);
    history.push(...buildFunctionResults(results, deps.page.url(), image));
    compactOldScreenshots(history);
  }

  logger.info(`Agent stopped at max turns (${deps.maxTurns})`);
  return { status: "max_turns", turns: deps.maxTurns, finalText, usage };
}
