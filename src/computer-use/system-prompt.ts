import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SYSTEM_PROMPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../files/system_prompt.txt",
);

export interface SystemPromptVars {
  readonly os: string;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly keyboardLayout: string;
}

export function osLabel(platform = process.platform): string {
  if (platform === "darwin") {
    return "Chromium on macOS";
  }
  if (platform === "win32") {
    return "Chromium on Windows";
  }
  if (platform === "linux") {
    return "Chromium on Linux";
  }

  return `Chromium on ${platform}`;
}

export function defaultSystemPromptVars(
  displayWidth: number,
  displayHeight: number,
  platform = process.platform,
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
): SystemPromptVars {
  return {
    os: osLabel(platform),
    displayWidth,
    displayHeight,
    keyboardLayout: locale,
  };
}

export function renderSystemPrompt(template: string, vars: SystemPromptVars): string {
  return template
    .replaceAll("{{os}}", vars.os)
    .replaceAll("{{display_width}}", String(vars.displayWidth))
    .replaceAll("{{display_height}}", String(vars.displayHeight))
    .replaceAll("{{keyboard_layout}}", vars.keyboardLayout)
    .trim();
}

export async function loadSystemPrompt(
  vars: SystemPromptVars,
  filePath = SYSTEM_PROMPT_PATH,
): Promise<string> {
  const template = await fs.readFile(filePath, "utf8");
  const rendered = renderSystemPrompt(template, vars);
  if (!rendered) {
    throw new Error("system_prompt.txt is empty");
  }

  return rendered;
}
