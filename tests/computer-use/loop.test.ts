import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runComputerUseLoop } from "../../src/computer-use/loop.js";
import {
  AgentRunError,
  type ComputerUsePage,
  type InteractionClient,
  type InteractionResponse,
} from "../../src/computer-use/types.js";
import { EMPTY_USAGE } from "../../src/shared/cost.js";

function createFakePage(): ComputerUsePage {
  return {
    url: () => "https://example.com/",
    goto: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    mouse: {
      click: async () => undefined,
      dblclick: async () => undefined,
      move: async () => undefined,
      down: async () => undefined,
      up: async () => undefined,
      wheel: async () => undefined,
    },
    keyboard: {
      type: async () => undefined,
      press: async () => undefined,
      down: async () => undefined,
      up: async () => undefined,
    },
  };
}

function scriptedClient(responses: InteractionResponse[]): InteractionClient & { inputs: unknown[][] } {
  const inputs: unknown[][] = [];
  let index = 0;

  return {
    inputs,
        async create(input) {
      inputs.push([...input]);
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error("Unexpected extra Gemini call");
      }

      return response;
    },
  };
}

describe("runComputerUseLoop", () => {
  it("stops when Gemini returns text and no function calls", async () => {
    const client = scriptedClient([
      {
        steps: [{ type: "model_output", content: [{ type: "text", text: "All done" }] }],
      },
    ]);

    const result = await runComputerUseLoop(
      {
        client,
        page: createFakePage(),
        saveScreenshot: async () => "/tmp/start.webp",
        confirmSafety: async () => true,
        screenWidth: 1024,
        screenHeight: 768,
        maxTurns: 15,
        readScreenshot: async () => "img",
      },
      "find pricing",
    );

    assert.equal(result.status, "completed");
    assert.equal(result.turns, 1);
    assert.equal(result.finalText, "All done");
    assert.equal(client.inputs.length, 1);
    assert.deepEqual(result.usage, EMPTY_USAGE);
  });

  it("executes a function call then finishes", async () => {
    const client = scriptedClient([
      {
        steps: [{ type: "function_call", id: "1", name: "wait", arguments: { seconds: 0 } }],
      },
      {
        steps: [{ type: "model_output", content: [{ type: "text", text: "Waited" }] }],
      },
    ]);

    const result = await runComputerUseLoop(
      {
        client,
        page: createFakePage(),
        saveScreenshot: async (name) => `/tmp/${name}.webp`,
        confirmSafety: async () => true,
        screenWidth: 1024,
        screenHeight: 768,
        maxTurns: 15,
        sleep: async () => undefined,
        readScreenshot: async () => "img",
      },
      "wait a moment",
    );

    assert.equal(result.status, "completed");
    assert.equal(result.turns, 2);
    assert.equal(result.finalText, "Waited");

    const secondInput = client.inputs[1] as Array<{ type: string }>;
    assert.equal(secondInput.at(-1)?.type, "function_result");
  });

  it("replays raw Gemini steps including extra fields", async () => {
    const client = scriptedClient([
      {
        steps: [
          { type: "thought", signature: "sig-1" },
          { type: "function_call", id: "1", name: "wait", arguments: { seconds: 0 } },
        ],
      },
      {
        steps: [{ type: "model_output", content: [{ type: "text", text: "Waited" }] }],
      },
    ]);

    await runComputerUseLoop(
      {
        client,
        page: createFakePage(),
        saveScreenshot: async (name) => `/tmp/${name}.webp`,
        confirmSafety: async () => true,
        screenWidth: 1024,
        screenHeight: 768,
        maxTurns: 15,
        sleep: async () => undefined,
        readScreenshot: async () => "img",
      },
      "wait a moment",
    );

    const secondInput = client.inputs[1] as Array<{ type?: string; signature?: string }>;
    assert.equal(secondInput[1]?.type, "thought");
    assert.equal(secondInput[1]?.signature, "sig-1");
  });

  it("stops at max turns", async () => {
    const client = scriptedClient([
      { steps: [{ type: "function_call", id: "1", name: "wait", arguments: { seconds: 0 } }] },
      { steps: [{ type: "function_call", id: "2", name: "wait", arguments: { seconds: 0 } }] },
    ]);

    const result = await runComputerUseLoop(
      {
        client,
        page: createFakePage(),
        saveScreenshot: async (name) => `/tmp/${name}.webp`,
        confirmSafety: async () => true,
        screenWidth: 1024,
        screenHeight: 768,
        maxTurns: 2,
        sleep: async () => undefined,
        readScreenshot: async () => "img",
      },
      "loop",
    );

    assert.equal(result.status, "max_turns");
    assert.equal(result.turns, 2);
  });

  it("aborts when Gemini API fails", async () => {
    const client: InteractionClient = {
      async create() {
        throw new Error("boom");
      },
    };

    await assert.rejects(
      () =>
        runComputerUseLoop(
          {
            client,
            page: createFakePage(),
            saveScreenshot: async () => "/tmp/start.webp",
            confirmSafety: async () => true,
            screenWidth: 1024,
            screenHeight: 768,
            maxTurns: 15,
            readScreenshot: async () => "img",
          },
          "task",
        ),
      (error: unknown) => {
        assert.ok(error instanceof AgentRunError);
        assert.match(error.message, /boom/);
        assert.deepEqual(error.usage, EMPTY_USAGE);
        return true;
      },
    );
  });

  it("keeps usage from finished turns when a later turn fails", async () => {
    const client: InteractionClient = {
      async create(input) {
        if (input.some((step) => step.type === "function_result")) {
          throw new Error("second turn failed");
        }

        return {
          steps: [{ type: "function_call", id: "1", name: "wait", arguments: { seconds: 0 } }],
          usage: { inputTokens: 10, outputTokens: 36, thoughtTokens: 0, cachedTokens: 0 },
        };
      },
    };

    await assert.rejects(
      () =>
        runComputerUseLoop(
          {
            client,
            page: createFakePage(),
            saveScreenshot: async (name) => `/tmp/${name}.webp`,
            confirmSafety: async () => true,
            screenWidth: 1024,
            screenHeight: 768,
            maxTurns: 15,
            sleep: async () => undefined,
            readScreenshot: async () => "img",
          },
          "task",
        ),
      (error: unknown) => {
        assert.ok(error instanceof AgentRunError);
        assert.deepEqual(error.usage, {
          inputTokens: 10,
          outputTokens: 36,
          thoughtTokens: 0,
          cachedTokens: 0,
        });
        return true;
      },
    );
  });

  it("stops when the user denies safety confirmation", async () => {
    const client = scriptedClient([
      {
        steps: [
          {
            type: "function_call",
            id: "1",
            name: "click",
            arguments: {
              x: 1,
              y: 1,
              safety_decision: { decision: "require_confirmation", explanation: "Buy now" },
            },
          },
        ],
      },
    ]);

    const result = await runComputerUseLoop(
      {
        client,
        page: createFakePage(),
        saveScreenshot: async () => "/tmp/start.webp",
        confirmSafety: async () => false,
        screenWidth: 1024,
        screenHeight: 768,
        maxTurns: 15,
        readScreenshot: async () => "img",
      },
      "buy",
    );

    assert.equal(result.status, "safety_denied");
    assert.equal(client.inputs.length, 1);
  });

  it("stops when the abort signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    let created = 0;
    const client: InteractionClient = {
      async create() {
        created += 1;
        return { steps: [{ type: "model_output", content: [{ type: "text", text: "nope" }] }] };
      },
    };

    await assert.rejects(
      () =>
        runComputerUseLoop(
          {
            client,
            page: createFakePage(),
            saveScreenshot: async () => "/tmp/start.webp",
            confirmSafety: async () => true,
            screenWidth: 1024,
            screenHeight: 768,
            maxTurns: 15,
            readScreenshot: async () => "img",
            signal: abort.signal,
          },
          "task",
        ),
      (error: unknown) => {
        assert.ok(error instanceof AgentRunError);
        assert.equal(error.message, "Agent stopped");
        return true;
      },
    );
    assert.equal(created, 0);
  });

  it("stops remaining turns after abort", async () => {
    const abort = new AbortController();
    const client = scriptedClient([
      { steps: [{ type: "function_call", id: "1", name: "wait", arguments: { seconds: 0 } }] },
      { steps: [{ type: "model_output", content: [{ type: "text", text: "Waited" }] }] },
    ]);

    await assert.rejects(
      () =>
        runComputerUseLoop(
          {
            client,
            page: createFakePage(),
            saveScreenshot: async (name) => {
              if (name === "wait") {
                abort.abort();
              }
              return `/tmp/${name}.webp`;
            },
            confirmSafety: async () => true,
            screenWidth: 1024,
            screenHeight: 768,
            maxTurns: 15,
            sleep: async () => undefined,
            readScreenshot: async () => "img",
            signal: abort.signal,
          },
          "wait a moment",
        ),
      /Agent stopped/,
    );
    assert.equal(client.inputs.length, 1);
  });

  it("sends safety_acknowledgement on the function result after confirm", async () => {
    const client = scriptedClient([
      {
        steps: [
          {
            type: "function_call",
            id: "1",
            name: "wait",
            arguments: {
              seconds: 0,
              safety_decision: { decision: "require_confirmation", explanation: "Create account" },
            },
          },
        ],
      },
      {
        steps: [{ type: "model_output", content: [{ type: "text", text: "Registered" }] }],
      },
    ]);

    const result = await runComputerUseLoop(
      {
        client,
        page: createFakePage(),
        saveScreenshot: async (name) => `/tmp/${name}.webp`,
        confirmSafety: async () => true,
        screenWidth: 1024,
        screenHeight: 768,
        maxTurns: 15,
        sleep: async () => undefined,
        readScreenshot: async () => "img",
      },
      "register",
    );

    assert.equal(result.status, "completed");
    const secondInput = client.inputs[1] as Array<{
      type?: string;
      safety_acknowledgement?: unknown;
      result?: Array<{ type?: string; text?: string }>;
    }>;
    const functionResult = secondInput.find((step) => step.type === "function_result");
    assert.equal(functionResult?.safety_acknowledgement, undefined);
    assert.equal(
      JSON.parse(String(functionResult?.result?.[0]?.text)).safety_acknowledgement,
      "true",
    );
  });
});
