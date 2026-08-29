import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../shared/config.js";
import { parseUsage } from "../shared/cost.js";
import { cloneSteps } from "./history.js";
import { AgentRunError, type InteractionClient, type InteractionResponse, type InteractionStep } from "./types.js";

type GeminiInteractionInput = Parameters<GoogleGenAI["interactions"]["create"]>[0]["input"];

const SUMMARY_RESPONSE_FORMAT = {
  type: "text",
  mime_type: "application/json",
  schema: {
    type: "object",
    required: ["action", "summary", "validations"],
    properties: {
      action: { type: "string", enum: ["summary"] },
      summary: { type: "string" },
      validations: {
        type: "array",
        items: {
          type: "object",
          required: ["check", "result", "observed"],
          properties: {
            check: { type: "string" },
            result: { type: "string", enum: ["pass", "fail"] },
            observed: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export function createGeminiInteractionClient(
  config: AppConfig,
  model = config.geminiModel,
  systemInstruction?: string,
): InteractionClient {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  return {
    async create(input: InteractionStep[]): Promise<InteractionResponse> {
      const interaction = await ai.interactions.create({
        model,
        store: false,
        ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
        input: input as GeminiInteractionInput,
        tools: [
          {
            type: "computer_use",
            environment: "browser",
            enable_prompt_injection_detection: false,
            ...(config.geminiDisabledSafetyPolicies.length > 0
              ? { disabled_safety_policies: [...config.geminiDisabledSafetyPolicies] }
              : {}),
          },
        ],
        generation_config: {
          thinking_level: config.geminiThinkingLevel,
          ...(config.geminiSeed !== undefined ? { seed: config.geminiSeed } : {}),
        },
        response_format: SUMMARY_RESPONSE_FORMAT,
      });

      const usage = parseUsage(interaction.usage);

      if (interaction.status === "failed") {
        throw new AgentRunError("Gemini interaction failed", usage);
      }

      return {
        steps: cloneSteps(interaction.steps),
        usage,
      };
    },
  };
}
