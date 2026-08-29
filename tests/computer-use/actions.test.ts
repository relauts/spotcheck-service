import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { denormalizeX, denormalizeY } from "../../src/computer-use/coords.js";
import { formatIntentLabel } from "../../src/computer-use/args.js";
import { buildFunctionResults, executeFunctionCalls } from "../../src/computer-use/actions.js";
import { AgentRunError, BROWSER_ACTION_NAMES, type ComputerUsePage, type FunctionCallStep } from "../../src/computer-use/types.js";

interface RecordedCall {
  target: string;
  name: string;
  args: unknown[];
}

function createFakePage(url = "https://example.com/"): ComputerUsePage & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let currentUrl = url;

  const record = (target: string, name: string) =>
    async (...args: unknown[]) => {
      calls.push({ target, name, args });
    };

  return {
    calls,
    url: () => currentUrl,
    goto: async (nextUrl: string) => {
      currentUrl = nextUrl;
      calls.push({ target: "page", name: "goto", args: [nextUrl] });
    },
    goBack: record("page", "goBack"),
    goForward: record("page", "goForward"),
    mouse: {
      click: record("mouse", "click"),
      dblclick: record("mouse", "dblclick"),
      move: record("mouse", "move"),
      down: record("mouse", "down"),
      up: record("mouse", "up"),
      wheel: record("mouse", "wheel"),
    },
    keyboard: {
      type: record("keyboard", "type"),
      press: record("keyboard", "press"),
      down: record("keyboard", "down"),
      up: record("keyboard", "up"),
    },
  };
}

function call(name: string, args: Record<string, unknown> = {}, id = `${name}-1`): FunctionCallStep {
  return { type: "function_call", id, name, arguments: args };
}

const screenWidth = 1024;
const screenHeight = 768;

async function run(name: string, args: Record<string, unknown> = {}, extra?: { confirm?: boolean }) {
  const page = createFakePage();
  const screenshots: string[] = [];
  const slept: number[] = [];

  const result = await executeFunctionCalls([call(name, args)], {
    page,
    screenWidth,
    screenHeight,
    saveScreenshot: async (actionName) => {
      const path = `/tmp/${actionName}.webp`;
      screenshots.push(path);
      return path;
    },
    confirmSafety: async () => extra?.confirm ?? true,
    sleep: async (ms) => {
      slept.push(ms);
    },
    selectAllKey: "Control+A",
  });

  return { page, screenshots, slept, result };
}

describe("formatIntentLabel", () => {
  it("joins action and intent", () => {
    assert.equal(formatIntentLabel("click", "open search"), "click — open search");
  });

  it("uses the action name when intent is missing", () => {
    assert.equal(formatIntentLabel("go_back", "N/A"), "go_back");
    assert.equal(formatIntentLabel("go_back", ""), "go_back");
  });

  it("marks failed actions", () => {
    assert.equal(formatIntentLabel("click", "open search", true), "click — open search (failed)");
    assert.equal(formatIntentLabel("click", "N/A", true), "click (failed)");
  });
});

describe("executeFunctionCalls", () => {
  it("covers every supported browser action", async () => {
    const page = createFakePage();
    const names: string[] = [];

    await executeFunctionCalls(
      BROWSER_ACTION_NAMES.map((name, index) =>
        call(
          name,
          {
            x: 100,
            y: 200,
            start_x: 10,
            start_y: 20,
            end_x: 30,
            end_y: 40,
            text: "hello",
            key: "Enter",
            keys: ["Control", "a"],
            direction: "down",
            url: "https://example.org",
            seconds: 0,
          },
          `${name}-${index}`,
        ),
      ),
      {
        page,
        screenWidth,
        screenHeight,
        saveScreenshot: async (actionName) => {
          names.push(actionName);
          return `/tmp/${actionName}.webp`;
        },
        confirmSafety: async () => true,
        sleep: async () => undefined,
        selectAllKey: "Control+A",
      },
    );

    assert.deepEqual(names, [...BROWSER_ACTION_NAMES]);
  });

  it("clicks at denormalized coordinates", async () => {
    const { page } = await run("click", { x: 500, y: 250, intent: "open link" });
    assert.deepEqual(page.calls[0], {
      target: "mouse",
      name: "click",
      args: [denormalizeX(500, screenWidth), denormalizeY(250, screenHeight)],
    });
  });

  it("double clicks", async () => {
    const { page } = await run("double_click", { x: 1, y: 1 });
    assert.equal(page.calls[0]?.name, "dblclick");
  });

  it("triple clicks", async () => {
    const { page } = await run("triple_click", { x: 1, y: 1 });
    assert.deepEqual(page.calls[0]?.args[2], { clickCount: 3 });
  });

  it("middle clicks", async () => {
    const { page } = await run("middle_click", { x: 1, y: 1 });
    assert.deepEqual(page.calls[0]?.args[2], { button: "middle" });
  });

  it("right clicks", async () => {
    const { page } = await run("right_click", { x: 1, y: 1 });
    assert.deepEqual(page.calls[0]?.args[2], { button: "right" });
  });

  it("presses and releases the mouse", async () => {
    const down = await run("mouse_down", { x: 10, y: 20 });
    assert.equal(down.page.calls[0]?.name, "move");
    assert.equal(down.page.calls[1]?.name, "down");

    const up = await run("mouse_up", { x: 10, y: 20 });
    assert.equal(up.page.calls[1]?.name, "up");
  });

  it("moves the cursor", async () => {
    const { page } = await run("move", { x: 10, y: 20 });
    assert.equal(page.calls[0]?.name, "move");
  });

  it("clears then types, and can press enter", async () => {
    const { page } = await run("type", { text: "hello", press_enter: true });
    assert.deepEqual(
      page.calls.map((item) => [item.name, item.args[0]]),
      [
        ["press", "Control+A"],
        ["press", "Backspace"],
        ["type", "hello"],
        ["press", "Enter"],
      ],
    );
  });

  it("drags from start to end", async () => {
    const { page } = await run("drag_and_drop", {
      start_x: 0,
      start_y: 0,
      end_x: 1000,
      end_y: 1000,
    });
    assert.deepEqual(
      page.calls.map((item) => item.name),
      ["move", "down", "move", "up"],
    );
    assert.deepEqual(page.calls[2]?.args, [denormalizeX(1000, screenWidth), denormalizeY(1000, screenHeight)]);
  });

  it("waits without a cap", async () => {
    const { slept } = await run("wait", { seconds: 2.5 });
    assert.deepEqual(slept, [2500]);
  });

  it("presses, holds, and releases keys", async () => {
    const press = await run("press_key", { key: "Return" });
    assert.deepEqual(press.page.calls[0], { target: "keyboard", name: "press", args: ["Enter"] });

    const down = await run("key_down", { key: "Shift" });
    assert.equal(down.page.calls[0]?.name, "down");

    const up = await run("key_up", { key: "Shift" });
    assert.equal(up.page.calls[0]?.name, "up");
  });

  it("presses a hotkey chord", async () => {
    const { page } = await run("hotkey", { keys: ["Control", "a"] });
    assert.deepEqual(
      page.calls.map((item) => [item.name, item.args[0]]),
      [
        ["down", "Control"],
        ["down", "a"],
        ["up", "a"],
        ["up", "Control"],
      ],
    );
  });

  it("take_screenshot only captures processed webp", async () => {
    const { page, screenshots } = await run("take_screenshot");
    assert.deepEqual(page.calls, []);
    assert.deepEqual(screenshots, ["/tmp/take_screenshot.webp"]);
  });

  it("scrolls at a coordinate", async () => {
    const { page } = await run("scroll", { x: 500, y: 500, direction: "up", magnitude_in_pixels: 80 });
    assert.equal(page.calls[0]?.name, "move");
    assert.deepEqual(page.calls[1], { target: "mouse", name: "wheel", args: [0, -80] });
  });

  it("navigates history and URLs", async () => {
    const back = await run("go_back");
    assert.equal(back.page.calls[0]?.name, "goBack");

    const forward = await run("go_forward");
    assert.equal(forward.page.calls[0]?.name, "goForward");

    const navigate = await run("navigate", { url: "https://example.org/docs" });
    assert.deepEqual(navigate.page.calls[0], {
      target: "page",
      name: "goto",
      args: ["https://example.org/docs"],
    });
  });

  it("emits intent labels and a failed suffix", async () => {
    const page = createFakePage();
    const labels: string[] = [];

    await executeFunctionCalls(
      [
        call("click", { x: 1, y: 1, intent: "open link" }),
        call("go_back"),
        call("click_at", { x: 1, y: 1 }),
      ],
      {
        page,
        screenWidth,
        screenHeight,
        saveScreenshot: async (name) => `/tmp/${name}.webp`,
        confirmSafety: async () => true,
        onIntent: (label) => {
          labels.push(label);
        },
      },
    );

    assert.deepEqual(labels, [
      "click — open link",
      "go_back",
      "click_at",
      "click_at (failed)",
    ]);
  });

  it("stops remaining actions when aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await assert.rejects(
      () =>
        executeFunctionCalls([call("go_back")], {
          page: createFakePage(),
          screenWidth,
          screenHeight,
          saveScreenshot: async (name) => `/tmp/${name}.webp`,
          confirmSafety: async () => true,
          signal: abort.signal,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgentRunError);
        assert.equal(error.message, "Agent stopped");
        return true;
      },
    );
  });

  it("skips unknown actions and continues", async () => {
    const page = createFakePage();
    const { results } = await executeFunctionCalls(
      [call("click_at", { x: 1, y: 1 }), call("go_back")],
      {
        page,
        screenWidth,
        screenHeight,
        saveScreenshot: async (name) => `/tmp/${name}.webp`,
        confirmSafety: async () => true,
      },
    );

    assert.match(String(results[0]?.payload.error), /Unsupported browser action: click_at/);
    assert.equal(page.calls[0]?.name, "goBack");
    assert.equal(results[1]?.payload.error, undefined);
  });

  it("stops remaining actions when safety is denied", async () => {
    const page = createFakePage();
    const { results, terminated } = await executeFunctionCalls(
      [
        call("click", {
          x: 1,
          y: 1,
          safety_decision: { decision: "require_confirmation", explanation: "Buy" },
        }),
        call("go_back"),
      ],
      {
        page,
        screenWidth,
        screenHeight,
        saveScreenshot: async (name) => `/tmp/${name}.webp`,
        confirmSafety: async () => false,
      },
    );

    assert.equal(terminated, true);
    assert.equal(results[0]?.payload.error, "User denied safety confirmation");
    assert.equal(results[1]?.payload.error, "Skipped after safety denial");
    assert.deepEqual(page.calls, []);
  });

  it("does not run blocked safety actions", async () => {
    const { page, result } = await run("click", {
      x: 1,
      y: 1,
      safety_decision: { decision: "blocked" },
    });

    assert.deepEqual(page.calls, []);
    assert.match(String(result.results[0]?.payload.error), /blocked by safety policy/);
  });

  it("acknowledges confirmed safety decisions", async () => {
    const { result } = await run(
      "click",
      {
        x: 1,
        y: 1,
        safety_decision: { decision: "require_confirmation", explanation: "ok" },
      },
      { confirm: true },
    );

    assert.equal(result.results[0]?.payload.safety_acknowledgement, "true");
  });

  it("builds webp function results", () => {
    const [response] = buildFunctionResults(
      [{ name: "click", callId: "abc", payload: { safety_acknowledgement: "true" } }],
      "https://example.com/",
      "webp-bytes",
    );

    assert.equal(response?.type, "function_result");
    assert.equal(response?.call_id, "abc");
    assert.equal(response?.is_error, undefined);
    assert.equal("safety_acknowledgement" in (response ?? {}), false);
    assert.equal(response?.result[1]?.mime_type, "image/webp");
    assert.equal(response?.result[1]?.data, "webp-bytes");
    assert.match(String(response?.result[0]?.text), /example.com/);
    assert.equal(JSON.parse(String(response?.result[0]?.text)).safety_acknowledgement, "true");
  });

  it("omits safety_acknowledgement when the action was not gated", () => {
    const [response] = buildFunctionResults(
      [{ name: "click", callId: "abc", payload: {} }],
      "https://example.com/",
      "webp-bytes",
    );

    assert.equal(JSON.parse(String(response?.result[0]?.text)).safety_acknowledgement, undefined);
  });
});
