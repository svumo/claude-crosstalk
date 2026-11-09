// What a task has spent, and whether it may spend more. Pure.
//
// GitHub bills Copilot in AI credits: tokens at each model's published rate, one credit a cent.
// A model with no rate here is counted in tokens and prompts only, and the prompt cap still holds.

import type { TokenUsage } from "../backend/adapter.ts";
import type { Caps, Usage } from "../protocol/schema.ts";

// US dollars per million tokens, from docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing.
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  claudesonnet55: { input: 2, cached: 0.1, output: 10 },
  claudeopus55: { input: 4, cached: 0.2, output: 20 },
};

const CREDITS_PER_DOLLAR = 100;

const key = (model: string): string => model.toLowerCase().replace(/[^a-z0-9]/g, "");

// The credits one turn cost, or null when the model's rate is not known. Cached tokens are taken
// to be part of the input count, and are charged at the cached rate.
export function creditsFor(model: string, turn: TokenUsage): number | null {
  const price = PRICES[key(model)];
  if (!price) {
    return null;
  }
  const fresh = Math.max(0, turn.inputTokens - turn.cachedTokens);
  const dollars = (fresh * price.input + turn.cachedTokens * price.cached + turn.outputTokens * price.output) / 1_000_000;
  return dollars * CREDITS_PER_DOLLAR;
}

export function addTurn(total: Usage, turn: TokenUsage, model: string): Usage {
  const credits = creditsFor(model, turn);
  return {
    prompts: total.prompts + 1,
    input_tokens: total.input_tokens + turn.inputTokens,
    output_tokens: total.output_tokens + turn.outputTokens,
    cached_tokens: total.cached_tokens + turn.cachedTokens,
    credits: credits === null || total.credits === null ? null : total.credits + credits,
  };
}

// Why the task may not start another turn, or "" when it may.
export function spent(usage: Usage, caps: Caps): string {
  if (usage.prompts >= caps.max_prompts) {
    return `it has used its ${caps.max_prompts} prompts`;
  }
  if (usage.credits !== null && usage.credits >= caps.credit_budget) {
    return `it has used ${usage.credits.toFixed(1)} of its ${caps.credit_budget} AI credits`;
  }
  if (caps.hops >= caps.wake_limit) {
    return `${caps.wake_limit} replies in a row with nobody typing`;
  }
  return "";
}

export const DEFAULT_CAPS: Caps = { hops: 0, wake_limit: 25, credit_budget: 100, max_prompts: 5 };
