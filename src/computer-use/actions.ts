import { asBoolean, asIntent, asNonNegativeNumber, asPoint, asString, asStringList, formatIntentLabel } from "./args.js";
import { isBrowserActionName } from "./history.js";
import { mapGeminiKey, mapGeminiKeys, selectAllShortcut } from "./keys.js";
import {
  isSafetyBlocked,
  readSafetyDecision,
  requiresSafetyConfirmation,
} from "./safety.js";
import { EMPTY_USAGE } from "../shared/cost.js";
import { logger } from "../shared/logger.js";
import {
  AgentRunError,
  type ActionResult,
  type BrowserActionName,
  type ComputerUsePage,
  type ExecuteTurnResult,
  type FunctionCallStep,
  type FunctionResultStep,
  type IntentListener,
  type SafetyConfirmer,
  type ScreenshotSaver,
  type Sleeper,
} from "./types.js";

export interface ExecuteActionsOptions {
  page: ComputerUsePage;
  screenWidth: number;
  screenHeight: number;
  saveScreenshot: ScreenshotSaver;
  confirmSafety: SafetyConfirmer;
  sleep?: Sleeper;
  selectAllKey?: string;
  onIntent?: IntentListener;
  signal?: AbortSignal;
}

type ActionHandler = (
  args: Record<string, unknown>,
  options: ExecuteActionsOptions,
) => Promise<void>;

const defaultSleep: Sleeper = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scrollDeltas(
  direction: string,
  magnitude: number,
): { deltaX: number; deltaY: number } {
  switch (direction.toLowerCase()) {
    case "up":
      return { deltaX: 0, deltaY: -magnitude };
    case "down":
      return { deltaX: 0, deltaY: magnitude };
    case "left":
      return { deltaX: -magnitude, deltaY: 0 };
    case "right":
      return { deltaX: magnitude, deltaY: 0 };
    default:
      throw new Error(`direction must be up, down, left, or right`);
  }
}

async function holdHotkey(page: ComputerUsePage, keys: string[]): Promise<void> {
  for (const key of keys) {
    await page.keyboard.down(key);
  }

  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (key) {
      await page.keyboard.up(key);
    }
  }
}

const ACTION_HANDLERS: Record<BrowserActionName, ActionHandler> = {
  async click(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.click(point.x, point.y);
  },
  async double_click(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.dblclick(point.x, point.y);
  },
  async triple_click(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.click(point.x, point.y, { clickCount: 3 });
  },
  async middle_click(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.click(point.x, point.y, { button: "middle" });
  },
  async right_click(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.click(point.x, point.y, { button: "right" });
  },
  async mouse_down(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
  },
  async mouse_up(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.move(point.x, point.y);
    await page.mouse.up();
  },
  async move(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    await page.mouse.move(point.x, point.y);
  },
  async type(args, { page, selectAllKey }) {
    const text = asString(args.text, "text");
    await page.keyboard.press(selectAllKey ?? selectAllShortcut());
    await page.keyboard.press("Backspace");
    await page.keyboard.type(text);
    if (asBoolean(args.press_enter, false)) {
      await page.keyboard.press("Enter");
    }
  },
  async drag_and_drop(args, { page, screenWidth, screenHeight }) {
    const start = asPoint({ x: args.start_x, y: args.start_y }, screenWidth, screenHeight);
    const end = asPoint({ x: args.end_x, y: args.end_y }, screenWidth, screenHeight);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    await page.mouse.up();
  },
  async wait(args, { sleep }) {
    const seconds = asNonNegativeNumber(args.seconds, "seconds", 1);
    await (sleep ?? defaultSleep)(seconds * 1000);
  },
  async press_key(args, { page }) {
    await page.keyboard.press(mapGeminiKey(asString(args.key, "key")));
  },
  async key_down(args, { page }) {
    await page.keyboard.down(mapGeminiKey(asString(args.key, "key")));
  },
  async key_up(args, { page }) {
    await page.keyboard.up(mapGeminiKey(asString(args.key, "key")));
  },
  async hotkey(args, { page }) {
    await holdHotkey(page, mapGeminiKeys(asStringList(args.keys, "keys")));
  },
  async take_screenshot() {
    // Screenshot is captured after every action.
  },
  async scroll(args, { page, screenWidth, screenHeight }) {
    const point = asPoint(args, screenWidth, screenHeight);
    const magnitude = asNonNegativeNumber(args.magnitude_in_pixels, "magnitude_in_pixels", 300);
    const { deltaX, deltaY } = scrollDeltas(asString(args.direction, "direction"), magnitude);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(deltaX, deltaY);
  },
  async go_back(_args, { page }) {
    await page.goBack();
  },
  async navigate(args, { page }) {
    await page.goto(asString(args.url, "url"));
  },
  async go_forward(_args, { page }) {
    await page.goForward();
  },
};

export async function executeFunctionCalls(
  calls: FunctionCallStep[],
  options: ExecuteActionsOptions,
): Promise<ExecuteTurnResult> {
  const results: ActionResult[] = [];
  let terminated = false;
  let lastScreenshotPath: string | undefined;

  for (const call of calls) {
    if (options.signal?.aborted) {
      throw new AgentRunError("Agent stopped", EMPTY_USAGE);
    }

    if (terminated) {
      results.push({
        name: call.name,
        callId: call.id,
        payload: { error: "Skipped after safety denial" },
      });
      continue;
    }

    const payload: Record<string, unknown> = {};
    const args = call.arguments;
    const intent = asIntent(args);
    logger.info(`Executing ${call.name} (Intent: ${intent})`);
    await options.onIntent?.(formatIntentLabel(call.name, intent));

    try {
      const safety = readSafetyDecision(args);
      if (isSafetyBlocked(safety)) {
        throw new Error("Action blocked by safety policy");
      }

      if (requiresSafetyConfirmation(safety)) {
        const confirmed = await options.confirmSafety(safety?.explanation ?? "", call.name);
        if (!confirmed) {
          terminated = true;
          payload.error = "User denied safety confirmation";
          await options.onIntent?.(formatIntentLabel(call.name, intent, true));
          results.push({ name: call.name, callId: call.id, payload });
          continue;
        }

        payload.safety_acknowledgement = "true";
      }

      if (!isBrowserActionName(call.name)) {
        throw new Error(`Unsupported browser action: ${call.name}`);
      }

      await ACTION_HANDLERS[call.name](args, options);
    } catch (error: unknown) {
      if (error instanceof AgentRunError) {
        throw error;
      }

      payload.error = errorMessage(error);
      logger.error(`Failed to execute ${call.name}`, error);
      await options.onIntent?.(formatIntentLabel(call.name, intent, true));
    }

    try {
      lastScreenshotPath = await options.saveScreenshot(call.name);
    } catch (error: unknown) {
      payload.error = payload.error
        ? `${String(payload.error)}; screenshot failed: ${errorMessage(error)}`
        : `screenshot failed: ${errorMessage(error)}`;
      logger.error(`Failed to screenshot after ${call.name}`, error);
    }

    results.push({ name: call.name, callId: call.id, payload });
  }

  return { results, terminated, lastScreenshotPath };
}

export function buildFunctionResults(
  results: ActionResult[],
  currentUrl: string,
  screenshotBase64: string,
): FunctionResultStep[] {
  return results.map((item) => {
    const hasError = typeof item.payload.error === "string";
    return {
      type: "function_result" as const,
      name: item.name,
      call_id: item.callId,
      ...(hasError ? { is_error: true } : {}),
      result: [
        {
          type: "text" as const,
          text: JSON.stringify({ url: currentUrl, ...item.payload }),
        },
        {
          type: "image" as const,
          data: screenshotBase64,
          mime_type: "image/webp" as const,
        },
      ],
    };
  });
}
