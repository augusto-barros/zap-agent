import type { AgentMessage } from "./agent-runtime.js";

export interface UsageTotals {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from cache (OpenAI cached_tokens). */
  cacheReadTokens: number;
  /** Always 0 for OpenAI (Anthropic-specific concept, kept for DB compat). */
  cacheCreationTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: UsageTotals = {
  model: "unknown",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

// ---- Pricing table (USD per 1M tokens) -------------------------------------
// Update when OpenAI changes pricing.
const PRICING: Record<string, { input: number; output: number; cached: number }> = {
  "gpt-4.1":      { input: 2.00,  output: 8.00,  cached: 0.50 },
  "gpt-4.1-mini": { input: 0.40,  output: 1.60,  cached: 0.10 },
  "gpt-4.1-nano": { input: 0.10,  output: 0.40,  cached: 0.025 },
  "gpt-4o":       { input: 2.50,  output: 10.00, cached: 1.25 },
  "gpt-4o-mini":  { input: 0.15,  output: 0.60,  cached: 0.075 },
};

function calcCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
): number {
  // Strip date suffixes like "gpt-4.1-mini-2025-04-14"
  const baseModel = Object.keys(PRICING).find((k) => model.startsWith(k)) ?? model;
  const p = PRICING[baseModel];
  if (!p) return 0;
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  return (
    (uncachedInput * p.input + outputTokens * p.output + cachedTokens * p.cached) /
    1_000_000
  );
}

// ---- Aggregate from our agent-runtime result event ------------------------

export function aggregateUsageFromResult(
  msg: Extract<AgentMessage, { type: "result" }>,
  requestedModel?: string,
): UsageTotals {
  const usage = msg._usage;
  const model = requestedModel ?? msg._model ?? "unknown";

  if (!usage) return { ...EMPTY_USAGE, model };

  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cachedTokens =
    (usage as { prompt_tokens_details?: { cached_tokens?: number } })
      .prompt_tokens_details?.cached_tokens ?? 0;

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens: cachedTokens,
    cacheCreationTokens: 0,
    costUsd: calcCost(model, inputTokens, outputTokens, cachedTokens),
  };
}
