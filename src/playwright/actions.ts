import type { Locator, Page } from "playwright";
import { createProcessedScreenshotSaver } from "./processed.js";

export type Selector = string | Locator;

export interface Coordinates {
  readonly x: number;
  readonly y: number;
}

type MouseClickOptions = Parameters<Page["mouse"]["click"]>[2];
type MouseDblclickOptions = Parameters<Page["mouse"]["dblclick"]>[2];
type MouseMoveOptions = Parameters<Page["mouse"]["move"]>[2];

export const PLAYWRIGHT_ACTION_NAMES = [
  "goto",
  "goBack",
  "goForward",
  "reload",
  "setContent",
  "click",
  "dblclick",
  "tap",
  "fill",
  "clear",
  "type",
  "pressSequentially",
  "press",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "selectText",
  "hover",
  "focus",
  "blur",
  "dragTo",
  "setInputFiles",
  "scrollIntoViewIfNeeded",
  "highlight",
  "screenshot",
  "dispatchEvent",
  "keyboard",
  "mouse",
  "touchscreen",
] as const;

export type PlaywrightActionName = (typeof PLAYWRIGHT_ACTION_NAMES)[number];

export interface PlaywrightActions {
  goto: Page["goto"];
  goBack: Page["goBack"];
  goForward: Page["goForward"];
  reload: Page["reload"];
  setContent: Page["setContent"];
  click: {
    (x: number, y: number, options?: MouseClickOptions): Promise<void>;
    (coords: Coordinates, options?: MouseClickOptions): Promise<void>;
    (target: Selector, options?: Parameters<Locator["click"]>[0]): Promise<void>;
  };
  dblclick: {
    (x: number, y: number, options?: MouseDblclickOptions): Promise<void>;
    (coords: Coordinates, options?: MouseDblclickOptions): Promise<void>;
    (target: Selector, options?: Parameters<Locator["dblclick"]>[0]): Promise<void>;
  };
  tap: {
    (x: number, y: number): Promise<void>;
    (coords: Coordinates): Promise<void>;
    (target: Selector, options?: Parameters<Locator["tap"]>[0]): Promise<void>;
  };
  fill: (target: Selector, ...args: Parameters<Locator["fill"]>) => Promise<void>;
  clear: (target: Selector, ...args: Parameters<Locator["clear"]>) => Promise<void>;
  type: (target: Selector, ...args: Parameters<Locator["type"]>) => Promise<void>;
  pressSequentially: (
    target: Selector,
    ...args: Parameters<Locator["pressSequentially"]>
  ) => Promise<void>;
  press: (target: Selector, ...args: Parameters<Locator["press"]>) => Promise<void>;
  check: (target: Selector, ...args: Parameters<Locator["check"]>) => Promise<void>;
  uncheck: (target: Selector, ...args: Parameters<Locator["uncheck"]>) => Promise<void>;
  setChecked: (target: Selector, ...args: Parameters<Locator["setChecked"]>) => Promise<void>;
  selectOption: (
    target: Selector,
    ...args: Parameters<Locator["selectOption"]>
  ) => Promise<Array<string>>;
  selectText: (target: Selector, ...args: Parameters<Locator["selectText"]>) => Promise<void>;
  hover: {
    (x: number, y: number, options?: MouseMoveOptions): Promise<void>;
    (coords: Coordinates, options?: MouseMoveOptions): Promise<void>;
    (target: Selector, options?: Parameters<Locator["hover"]>[0]): Promise<void>;
  };
  focus: (target: Selector, ...args: Parameters<Locator["focus"]>) => Promise<void>;
  blur: (target: Selector, ...args: Parameters<Locator["blur"]>) => Promise<void>;
  dragTo: {
    (from: Coordinates, to: Coordinates): Promise<void>;
    (source: Selector, target: Selector, options?: Parameters<Locator["dragTo"]>[1]): Promise<void>;
    (source: Selector | Coordinates, target: Selector | Coordinates): Promise<void>;
  };
  setInputFiles: (target: Selector, ...args: Parameters<Locator["setInputFiles"]>) => Promise<void>;
  scrollIntoViewIfNeeded: (
    target: Selector,
    ...args: Parameters<Locator["scrollIntoViewIfNeeded"]>
  ) => Promise<void>;
  highlight: (target: Selector, ...args: Parameters<Locator["highlight"]>) => Promise<void>;
  screenshot: (target?: Selector, options?: Parameters<Locator["screenshot"]>[0]) => Promise<Buffer>;
  dispatchEvent: (
    target: Selector,
    ...args: Parameters<Locator["dispatchEvent"]>
  ) => Promise<void>;
  keyboard: {
    down: Page["keyboard"]["down"];
    up: Page["keyboard"]["up"];
    insertText: Page["keyboard"]["insertText"];
    type: Page["keyboard"]["type"];
    press: Page["keyboard"]["press"];
  };
  mouse: {
    move: Page["mouse"]["move"];
    down: Page["mouse"]["down"];
    up: Page["mouse"]["up"];
    click: Page["mouse"]["click"];
    dblclick: Page["mouse"]["dblclick"];
    wheel: Page["mouse"]["wheel"];
  };
  touchscreen: {
    tap: Page["touchscreen"]["tap"];
  };
}

export function isCoordinates(value: unknown): value is Coordinates {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as { x?: unknown; y?: unknown; click?: unknown };
  return (
    typeof record.x === "number" &&
    Number.isFinite(record.x) &&
    typeof record.y === "number" &&
    Number.isFinite(record.y) &&
    typeof record.click !== "function"
  );
}

function toLocator(page: Page, target: Selector): Locator {
  return typeof target === "string" ? page.locator(target) : target;
}

function splitPointTarget(
  targetOrX: Selector | Coordinates | number,
  yOrOptions?: unknown,
  maybeOptions?: unknown,
): { kind: "point"; x: number; y: number; options: unknown } | { kind: "locator"; target: Selector; options: unknown } {
  if (typeof targetOrX === "number") {
    if (typeof yOrOptions !== "number" || !Number.isFinite(yOrOptions)) {
      throw new Error("Y coordinate is required when X is a number");
    }

    return { kind: "point", x: targetOrX, y: yOrOptions, options: maybeOptions };
  }

  if (isCoordinates(targetOrX)) {
    return { kind: "point", x: targetOrX.x, y: targetOrX.y, options: yOrOptions };
  }

  return { kind: "locator", target: targetOrX, options: yOrOptions };
}

async function pointFromTarget(page: Page, target: Selector | Coordinates): Promise<Coordinates> {
  if (isCoordinates(target)) {
    return target;
  }

  const box = await toLocator(page, target).boundingBox();
  if (!box) {
    throw new Error("Cannot read coordinates; element has no bounding box");
  }

  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

export function createPageActions(page: Page, directory?: string): PlaywrightActions {
  const locator = (target: Selector): Locator => toLocator(page, target);
  const saveScreenshot = createProcessedScreenshotSaver(page, directory);

  async function afterAction<T>(actionName: string, run: () => Promise<T>): Promise<T> {
    const result = await run();
    await saveScreenshot(actionName);
    return result;
  }

  return {
    goto: (...args) => afterAction("goto", () => page.goto(...args)),
    goBack: (...args) => afterAction("goBack", () => page.goBack(...args)),
    goForward: (...args) => afterAction("goForward", () => page.goForward(...args)),
    reload: (...args) => afterAction("reload", () => page.reload(...args)),
    setContent: (...args) => afterAction("setContent", () => page.setContent(...args)),

    click: async (
      targetOrX: Selector | Coordinates | number,
      yOrOptions?: number | MouseClickOptions | Parameters<Locator["click"]>[0],
      maybeOptions?: MouseClickOptions,
    ) =>
      afterAction("click", async () => {
        const target = splitPointTarget(targetOrX, yOrOptions, maybeOptions);
        if (target.kind === "point") {
          await page.mouse.click(target.x, target.y, target.options as MouseClickOptions);
          return;
        }

        await locator(target.target).click(target.options as Parameters<Locator["click"]>[0]);
      }),
    dblclick: async (
      targetOrX: Selector | Coordinates | number,
      yOrOptions?: number | MouseDblclickOptions | Parameters<Locator["dblclick"]>[0],
      maybeOptions?: MouseDblclickOptions,
    ) =>
      afterAction("dblclick", async () => {
        const target = splitPointTarget(targetOrX, yOrOptions, maybeOptions);
        if (target.kind === "point") {
          await page.mouse.dblclick(target.x, target.y, target.options as MouseDblclickOptions);
          return;
        }

        await locator(target.target).dblclick(target.options as Parameters<Locator["dblclick"]>[0]);
      }),
    tap: async (
      targetOrX: Selector | Coordinates | number,
      yOrOptions?: number | Parameters<Locator["tap"]>[0],
    ) =>
      afterAction("tap", async () => {
        const target = splitPointTarget(targetOrX, yOrOptions);
        if (target.kind === "point") {
          await page.touchscreen.tap(target.x, target.y);
          return;
        }

        await locator(target.target).tap(target.options as Parameters<Locator["tap"]>[0]);
      }),

    fill: (target, ...args) => afterAction("fill", () => locator(target).fill(...args)),
    clear: (target, ...args) => afterAction("clear", () => locator(target).clear(...args)),
    type: (target, ...args) => afterAction("type", () => locator(target).type(...args)),
    pressSequentially: (target, ...args) =>
      afterAction("pressSequentially", () => locator(target).pressSequentially(...args)),
    press: (target, ...args) => afterAction("press", () => locator(target).press(...args)),

    check: (target, ...args) => afterAction("check", () => locator(target).check(...args)),
    uncheck: (target, ...args) => afterAction("uncheck", () => locator(target).uncheck(...args)),
    setChecked: (target, ...args) =>
      afterAction("setChecked", () => locator(target).setChecked(...args)),

    selectOption: (target, ...args) =>
      afterAction("selectOption", () => locator(target).selectOption(...args)),
    selectText: (target, ...args) =>
      afterAction("selectText", () => locator(target).selectText(...args)),

    hover: async (
      targetOrX: Selector | Coordinates | number,
      yOrOptions?: number | MouseMoveOptions | Parameters<Locator["hover"]>[0],
      maybeOptions?: MouseMoveOptions,
    ) =>
      afterAction("hover", async () => {
        const target = splitPointTarget(targetOrX, yOrOptions, maybeOptions);
        if (target.kind === "point") {
          await page.mouse.move(target.x, target.y, target.options as MouseMoveOptions);
          return;
        }

        await locator(target.target).hover(target.options as Parameters<Locator["hover"]>[0]);
      }),
    focus: (target, ...args) => afterAction("focus", () => locator(target).focus(...args)),
    blur: (target, ...args) => afterAction("blur", () => locator(target).blur(...args)),

    dragTo: async (
      source: Selector | Coordinates,
      target: Selector | Coordinates,
      options?: Parameters<Locator["dragTo"]>[1],
    ) =>
      afterAction("dragTo", async () => {
        if (!isCoordinates(source) && !isCoordinates(target) && options) {
          await locator(source).dragTo(locator(target), options);
          return;
        }

        const from = await pointFromTarget(page, source);
        const to = await pointFromTarget(page, target);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y);
        await page.mouse.up();
      }),
    setInputFiles: (target, ...args) =>
      afterAction("setInputFiles", () => locator(target).setInputFiles(...args)),

    scrollIntoViewIfNeeded: (target, ...args) =>
      afterAction("scrollIntoViewIfNeeded", () => locator(target).scrollIntoViewIfNeeded(...args)),
    highlight: (target, ...args) =>
      afterAction("highlight", async () => {
        await locator(target).highlight(...args);
      }),
    screenshot: (target, options) =>
      afterAction("screenshot", () =>
        target === undefined ? page.screenshot() : locator(target).screenshot(options),
      ),
    dispatchEvent: (target, ...args) =>
      afterAction("dispatchEvent", () => locator(target).dispatchEvent(...args)),

    keyboard: {
      down: (...args) => afterAction("keyboard-down", () => page.keyboard.down(...args)),
      up: (...args) => afterAction("keyboard-up", () => page.keyboard.up(...args)),
      insertText: (...args) =>
        afterAction("keyboard-insertText", () => page.keyboard.insertText(...args)),
      type: (...args) => afterAction("keyboard-type", () => page.keyboard.type(...args)),
      press: (...args) => afterAction("keyboard-press", () => page.keyboard.press(...args)),
    },
    mouse: {
      move: (...args) => afterAction("mouse-move", () => page.mouse.move(...args)),
      down: (...args) => afterAction("mouse-down", () => page.mouse.down(...args)),
      up: (...args) => afterAction("mouse-up", () => page.mouse.up(...args)),
      click: (...args) => afterAction("mouse-click", () => page.mouse.click(...args)),
      dblclick: (...args) => afterAction("mouse-dblclick", () => page.mouse.dblclick(...args)),
      wheel: (...args) => afterAction("mouse-wheel", () => page.mouse.wheel(...args)),
    },
    touchscreen: {
      tap: (...args) => afterAction("touchscreen-tap", () => page.touchscreen.tap(...args)),
    },
  };
}
