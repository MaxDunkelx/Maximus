import type { TokenUsage } from './types.js';

/**
 * Published xAI rates for grok-4.7 as of 2026-10-09.
 * Source: https://docs.x.ai/developers/models
 * Short context is under 200k prompt tokens: $2 input, $0.50 cached input, $6 output per 1M.
 * At or above 200k, the whole request uses $4 / $1 / $12.
 * Unknown models return null rather than a guessed price.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  if (model !== 'grok-4.7') return null;
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), Math.max(usage.inputTokens, 0));
  const uncached = Math.max(usage.inputTokens, 0) - cached;
  const longContext = usage.inputTokens >= 200_000;
  const inputRate = longContext ? 4 : 2;
  const cachedRate = longContext ? 1 : 0.5;
  const outputRate = longContext ? 12 : 6;
  const cost = (uncached * inputRate + cached * cachedRate + Math.max(usage.outputTokens, 0) * outputRate) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
