import { and, eq, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ApiError } from "../auth/guard";
import { db } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { sha256 } from "../security/crypto";

const KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;
export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Stripe-style idempotency for POSTs that start work. With an `Idempotency-Key`
 * header, the first request runs and its response is stored; retries with the
 * same key and body replay that response instead of starting a second run.
 * A different body with the same key is rejected, as is a retry while the
 * original is still in flight.
 */
export async function idempotent(
  req: Request,
  userId: string,
  route: string,
  rawBody: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key) return NextResponse.json(await run());
  if (!KEY_RE.test(key)) throw new ApiError(400, "Idempotency-Key must be 8–100 characters of [A-Za-z0-9._:-]", "invalid");

  const requestHash = sha256(rawBody);
  const [claimed] = await db()
    .insert(idempotencyKeys)
    .values({ userId, route, key, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });

  const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.route, route), eq(idempotencyKeys.key, key));
  if (!claimed) {
    const [existing] = await db().select().from(idempotencyKeys).where(where);
    if (!existing) throw new ApiError(409, "Idempotency key conflict; retry", "idempotency_conflict");
    if (existing.requestHash !== requestHash) {
      throw new ApiError(422, "This Idempotency-Key was already used with a different request body", "idempotency_mismatch");
    }
    if (existing.status === null) throw new ApiError(409, "The original request with this Idempotency-Key is still in progress", "idempotency_in_progress");
    return NextResponse.json(existing.response, { status: existing.status, headers: { "idempotent-replayed": "true" } });
  }

  try {
    const response = await run();
    await db().update(idempotencyKeys).set({ status: 200, response }).where(where);
    return NextResponse.json(response);
  } catch (err) {
    // Failed requests don't consume the key, so the client can fix and retry.
    await db().delete(idempotencyKeys).where(where);
    throw err;
  }
}

export async function pruneIdempotencyKeys() {
  await db()
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, sql`now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`));
}
