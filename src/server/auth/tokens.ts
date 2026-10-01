import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/client";
import { apiTokens, users } from "../db/schema";
import { randomToken, sha256 } from "../security/crypto";
import type { CurrentSession } from "./session";

export type TokenScope = "read" | "write";
const TOKEN_RE = /^ait_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 5 * 60_000;

/** Returns the plaintext token exactly once; only its hash is stored. */
export async function createApiToken(userId: string, name: string, scopes: TokenScope[], expiresInDays: number | null) {
  const prefix = randomToken(6).slice(0, 8);
  const token = `ait_${prefix}_${randomToken(32)}`;
  const [row] = await db()
    .insert(apiTokens)
    .values({
      userId,
      name,
      tokenHash: sha256(token),
      prefix: `ait_${prefix}`,
      scopes,
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
    })
    .returning();
  return { token, record: view(row!) };
}

function view(r: typeof apiTokens.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

export async function listApiTokens(userId: string) {
  const rows = await db().select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt));
  return rows.map(view);
}

export async function revokeApiToken(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const res = await db().delete(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId))).returning({ id: apiTokens.id });
  return res.length > 0;
}

/** Resolve a bearer token to an auth context, or null if unknown, malformed or expired. */
export async function lookupApiToken(token: string): Promise<CurrentSession | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db()
    .select({
      id: apiTokens.id,
      scopes: apiTokens.scopes,
      lastUsedAt: apiTokens.lastUsedAt,
      user: { id: users.id, email: users.email, name: users.name },
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(token)), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date()))))
    .limit(1);
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await db().update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
  }
  return { id: `token:${row.id}`, kind: "token", scopes: row.scopes as TokenScope[], tokenId: row.id, user: row.user };
}
