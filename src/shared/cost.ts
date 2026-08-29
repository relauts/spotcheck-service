export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens: number;
  readonly cachedTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedTokens: 0,
};

export interface ModelPrices {
  readonly input_price_per_million: number;
  readonly output_price_per_million: number;
  readonly cache_price_per_million: number;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function parseUsage(value: unknown): TokenUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return EMPTY_USAGE;
  }

  const raw = value as Record<string, unknown>;
  return {
    inputTokens: toCount(raw.total_input_tokens),
    outputTokens: toCount(raw.total_output_tokens),
    thoughtTokens: toCount(raw.total_thought_tokens),
    cachedTokens: toCount(raw.total_cached_tokens),
  };
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    thoughtTokens: left.thoughtTokens + right.thoughtTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
  };
}

export function computeCostUsd(usage: TokenUsage, prices: ModelPrices): number {
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const input = usage.inputTokens - cached;
  const output = usage.outputTokens + usage.thoughtTokens;
  const cost =
    (input * prices.input_price_per_million +
      cached * prices.cache_price_per_million +
      output * prices.output_price_per_million) /
    1_000_000;
  return Number(cost.toFixed(6));
}
