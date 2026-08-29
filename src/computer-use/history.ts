import { BROWSER_ACTION_NAMES, type BrowserActionName, type InteractionStep } from "./types.js";

const BROWSER_ACTION_SET = new Set<string>(BROWSER_ACTION_NAMES);
const OLD_SCREENSHOT_PLACEHOLDER = [{ type: "text", text: "[old screenshot removed]" }];

export function isBrowserActionName(name: string): name is BrowserActionName {
  return BROWSER_ACTION_SET.has(name);
}

export function getFunctionCalls(steps: InteractionStep[]): Array<{
  type: "function_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}> {
  return steps.flatMap((step) => {
    if (step.type !== "function_call") {
      return [];
    }

    if (!step.id || !step.name) {
      return [];
    }

    return [
      {
        type: "function_call" as const,
        id: step.id,
        name: step.name,
        arguments: step.arguments ?? {},
      },
    ];
  });
}

export function extractModelText(steps: InteractionStep[]): string {
  return steps
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ")
    .trim();
}

function hasImageResult(result: unknown): boolean {
  return (
    Array.isArray(result) &&
    result.some((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image")
  );
}

export function cloneSteps(steps: unknown): InteractionStep[] {
  return JSON.parse(JSON.stringify(steps)) as InteractionStep[];
}

export function compactOldScreenshots(history: InteractionStep[]): InteractionStep[] {
  let keepLatest = true;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item || item.type !== "function_result" || !hasImageResult(item.result)) {
      continue;
    }

    if (keepLatest) {
      keepLatest = false;
      continue;
    }

    const textBlocks = Array.isArray(item.result)
      ? item.result.filter(
          (block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
        )
      : [];
    item.result = textBlocks.length > 0 ? textBlocks : OLD_SCREENSHOT_PLACEHOLDER;
  }

  return history;
}
