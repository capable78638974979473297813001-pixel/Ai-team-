import type { RunLimits, RunUsage } from "../db/schema";

export const DEFAULT_LIMITS: RunLimits = {
  maxRounds: 2,
  maxAgents: 5,
  maxCalls: 16,
  maxRuntimeMs: 8 * 60_000,
  maxCostUsd: null,
};

export const LIMIT_BOUNDS = {
  maxRounds: [1, 4],
  maxAgents: [1, 6],
  maxCalls: [2, 40],
  maxRuntimeMs: [30_000, 30 * 60_000],
  maxCostUsd: [0.01, 100],
} as const;

export function clampLimits(input: Partial<RunLimits> | undefined): RunLimits {
  const l = { ...DEFAULT_LIMITS, ...(input ?? {}) };
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    maxRounds: clamp(l.maxRounds, LIMIT_BOUNDS.maxRounds),
    maxAgents: clamp(l.maxAgents, LIMIT_BOUNDS.maxAgents),
    maxCalls: clamp(l.maxCalls, LIMIT_BOUNDS.maxCalls),
    maxRuntimeMs: clamp(l.maxRuntimeMs, LIMIT_BOUNDS.maxRuntimeMs),
    maxCostUsd:
      l.maxCostUsd == null ? null : Math.min(LIMIT_BOUNDS.maxCostUsd[1], Math.max(LIMIT_BOUNDS.maxCostUsd[0], Number(l.maxCostUsd))),
  };
}

type Price = { inputPerMTok: number; outputPerMTok: number };

/** First-party list prices we can state with confidence; extend via PRICING_JSON. */
const BUILTIN_PRICES: Record<string, Price> = {
  "anthropic:claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "anthropic:claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "anthropic:claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "anthropic:claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
};

export function loadPricing(json?: string): Record<string, Price> {
  if (!json) return BUILTIN_PRICES;
  try {
    return { ...BUILTIN_PRICES, ...(JSON.parse(json) as Record<string, Price>) };
  } catch {
    return BUILTIN_PRICES;
  }
}

/**
 * Enforces run limits. Every provider call must pass `canCall` first; the
 * orchestrator reserves capacity for the final synthesis so a run always ends
 * with an answer rather than being cut off mid-flight.
 */
export class Budget {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  knownCost = 0;
  unpricedCalls = 0;

  constructor(
    readonly limits: RunLimits,
    private readonly startedAt: number,
    private readonly pricing: Record<string, Price> = BUILTIN_PRICES,
    private readonly now: () => number = Date.now,
  ) {}

  elapsedMs() {
    return this.now() - this.startedAt;
  }

  remainingMs() {
    return Math.max(0, this.limits.maxRuntimeMs - this.elapsedMs());
  }

  /** Why no more (non-reserved) calls may be made, or null. */
  exhaustedReason(reserve = 0): string | null {
    if (this.calls + 1 + reserve > this.limits.maxCalls) return `the call limit (${this.limits.maxCalls}) was reached`;
    if (this.elapsedMs() >= this.limits.maxRuntimeMs) return `the time limit (${Math.round(this.limits.maxRuntimeMs / 1000)}s) was reached`;
    if (this.limits.maxCostUsd != null && this.knownCost >= this.limits.maxCostUsd) {
      return `the cost limit ($${this.limits.maxCostUsd.toFixed(2)}) was reached`;
    }
    return null;
  }

  canCall(reserve = 0) {
    return this.exhaustedReason(reserve) === null;
  }

  /** The synthesis call may use the reserved slot even when time has run out. */
  canSynthesize() {
    return this.calls < this.limits.maxCalls;
  }

  begin() {
    this.calls++;
  }

  record(provider: string, model: string, usage: { inputTokens: number; outputTokens: number }) {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    const price = this.pricing[`${provider}:${model}`];
    if (price) this.knownCost += (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1e6;
    else if (usage.inputTokens + usage.outputTokens > 0) this.unpricedCalls++;
  }

  usage(): RunUsage {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.knownCost > 0 || this.unpricedCalls === 0 ? Math.round(this.knownCost * 10000) / 10000 : null,
      elapsedMs: this.elapsedMs(),
    };
  }
}
