/**
 * Fixed-window-with-sliding-refill token bucket, in memory. Suitable for a
 * single instance; swap `store` for Redis in a multi-instance deployment.
 */
type Bucket = { tokens: number; updated: number };
const store = new Map<string, Bucket>();

export type RateRule = { capacity: number; refillPerSec: number };

export const RULES = {
  auth: { capacity: 10, refillPerSec: 10 / 60 }, // 10 per minute burst
  connect: { capacity: 20, refillPerSec: 20 / 300 },
  task: { capacity: 12, refillPerSec: 12 / 60 },
  api: { capacity: 120, refillPerSec: 2 },
} satisfies Record<string, RateRule>;

export function rateLimit(key: string, rule: RateRule, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const b = store.get(key) ?? { tokens: rule.capacity, updated: now };
  const elapsed = (now - b.updated) / 1000;
  b.tokens = Math.min(rule.capacity, b.tokens + elapsed * rule.refillPerSec);
  b.updated = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    store.set(key, b);
    return { ok: true, retryAfterSec: 0 };
  }
  store.set(key, b);
  if (store.size > 50_000) prune(now);
  return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / rule.refillPerSec) };
}

function prune(now: number) {
  for (const [k, b] of store) if (now - b.updated > 3_600_000) store.delete(k);
}

export function resetRateLimits() {
  store.clear();
}
