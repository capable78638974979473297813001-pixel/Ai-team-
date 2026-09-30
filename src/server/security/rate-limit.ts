import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { rateLimits } from "../db/schema";
import { distributed } from "../env";
import { log } from "./redact";

/**
 * Token-bucket rate limiting. The in-memory store suits a single instance;
 * RATE_LIMIT_STORE=postgres shares buckets across instances with one atomic
 * upsert per check.
 */
export type RateRule = { capacity: number; refillPerSec: number };
export type RateResult = { ok: boolean; retryAfterSec: number };

export const RULES = {
  auth: { capacity: 10, refillPerSec: 10 / 60 }, // 10 per minute burst
  connect: { capacity: 20, refillPerSec: 20 / 300 },
  task: { capacity: 12, refillPerSec: 12 / 60 },
  api: { capacity: 120, refillPerSec: 2 },
} satisfies Record<string, RateRule>;

type Bucket = { tokens: number; updated: number };
const memory = new Map<string, Bucket>();

export function rateLimitMemory(key: string, rule: RateRule, now = Date.now()): RateResult {
  const b = memory.get(key) ?? { tokens: rule.capacity, updated: now };
  b.tokens = Math.min(rule.capacity, b.tokens + ((now - b.updated) / 1000) * rule.refillPerSec);
  b.updated = now;
  memory.set(key, b);
  if (memory.size > 50_000) prune(now);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }
  return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / rule.refillPerSec) };
}

function prune(now: number) {
  for (const [k, b] of memory) if (now - b.updated > 3_600_000) memory.delete(k);
}

export async function rateLimitPostgres(key: string, rule: RateRule): Promise<RateResult> {
  const cap = rule.capacity;
  const refill = rule.refillPerSec;
  // refilled = min(cap, tokens + elapsed * refill); take one token only if one is available.
  const refilled = sql`least(${cap}::double precision, ${rateLimits.tokens} + extract(epoch from (now() - ${rateLimits.updatedAt})) * ${refill}::double precision)`;
  const [row] = await db()
    .insert(rateLimits)
    .values({ key, tokens: cap - 1, allowed: true, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        tokens: sql`case when ${refilled} >= 1 then ${refilled} - 1 else ${refilled} end`,
        allowed: sql`${refilled} >= 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ tokens: rateLimits.tokens, allowed: rateLimits.allowed });
  if (!row || row.allowed) return { ok: true, retryAfterSec: 0 };
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - row.tokens) / refill)) };
}

export async function rateLimit(key: string, rule: RateRule): Promise<RateResult> {
  if (!distributed("RATE_LIMIT_STORE")) return rateLimitMemory(key, rule);
  try {
    return await rateLimitPostgres(key, rule);
  } catch (err) {
    // Fail open to the local limiter rather than taking the API down with the limiter.
    log.error("rate limiter store unavailable; falling back to memory", err);
    return rateLimitMemory(key, rule);
  }
}

export async function pruneRateLimits() {
  memory.clear();
  if (distributed("RATE_LIMIT_STORE")) {
    await db().delete(rateLimits).where(sql`${rateLimits.updatedAt} < now() - interval '1 hour'`);
  }
}

export function resetRateLimits() {
  memory.clear();
}
