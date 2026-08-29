import type { TokenUsage } from "../shared/cost.js";

export const BROWSER_ACTION_NAMES = [
  "click",
  "double_click",
  "triple_click",
  "middle_click",
  "right_click",
  "mouse_down",
  "mouse_up",
  "move",
  "type",
  "drag_and_drop",
  "wait",
  "press_key",
  "key_down",
  "key_up",
  "hotkey",
  "take_screenshot",
  "scroll",
  "go_back",
  "navigate",
  "go_forward",
] as const;

export type BrowserActionName = (typeof BROWSER_ACTION_NAMES)[number];

export type MouseButton = "left" | "right" | "middle";

export interface ComputerUseMouse {
  click(
    x: number,
    y: number,
    options?: { button?: MouseButton; clickCount?: number },
  ): Promise<void>;
  dblclick(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface ComputerUseKeyboard {
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}

export interface ComputerUsePage {
  url(): string;
  goto(url: string): Promise<unknown>;
  goBack(): Promise<unknown>;
  goForward(): Promise<unknown>;
  mouse: ComputerUseMouse;
  keyboard: ComputerUseKeyboard;
}

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mime_type?: string;
}

export interface InteractionStep {
  type: string;
  id?: string;
  name?: string;
  call_id?: string;
  arguments?: Record<string, unknown>;
  content?: ContentBlock[];
  result?: unknown;
  is_error?: boolean;
}

export interface FunctionCallStep extends InteractionStep {
  type: "function_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface FunctionResultStep extends InteractionStep {
  type: "function_result";
  call_id: string;
  name: string;
  is_error?: boolean;
  result: ContentBlock[];
}

export interface InteractionResponse {
  steps: InteractionStep[];
  usage?: TokenUsage;
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly usage: TokenUsage,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

export interface InteractionClient {
  create(input: InteractionStep[]): Promise<InteractionResponse>;
}

export type ScreenshotSaver = (actionName: string) => Promise<string>;
export type SafetyConfirmer = (explanation: string, actionName: string) => Promise<boolean>;
export type Sleeper = (ms: number) => Promise<void>;
export type IntentListener = (label: string) => void | Promise<void>;

export interface ActionResult {
  name: string;
  callId: string;
  payload: Record<string, unknown>;
}

export interface ExecuteTurnResult {
  results: ActionResult[];
  terminated: boolean;
  lastScreenshotPath: string | undefined;
}
