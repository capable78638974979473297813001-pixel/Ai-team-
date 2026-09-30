import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "../db/client";
import { sessions, users } from "../db/schema";
import { secureCookies } from "../env";
import { hmac, randomToken, safeEqual, sha256 } from "../security/crypto";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

export function sessionCookieName() {
  // The __Host- prefix forces Secure, Path=/ and no Domain: only possible over https.
  return secureCookies() ? "__Host-aiteam_session" : "aiteam_session";
}

export type SessionUser = { id: string; email: string; name: string };
export type CurrentSession = { id: string; user: SessionUser };

export async function createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const token = randomToken(32);
  const id = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db()
    .insert(sessions)
    .values({ id, userId, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null });
  const jar = await cookies();
  jar.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return { id };
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(sessionCookieName())?.value ?? null;
}

export async function lookupSession(token: string | null): Promise<CurrentSession | null> {
  if (!token || token.length > 200) return null;
  const id = sha256(token);
  const rows = await db()
    .select({
      id: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      user: { id: users.id, email: users.email, name: users.name },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db().update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, id));
  }
  return { id: row.id, user: row.user };
}

export async function getSession(): Promise<CurrentSession | null> {
  return lookupSession(await readSessionToken());
}

export async function destroySession(sessionId: string) {
  await db().delete(sessions).where(eq(sessions.id, sessionId));
  const jar = await cookies();
  jar.delete(sessionCookieName());
}

export async function destroyAllSessions(userId: string) {
  await db().delete(sessions).where(eq(sessions.userId, userId));
}

export async function pruneExpiredSessions() {
  await db().delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

/** CSRF token bound to the session (synchroniser token derived with HMAC). */
export function csrfTokenFor(sessionId: string) {
  return hmac(`csrf:${sessionId}`);
}

export function verifyCsrf(sessionId: string, token: string | null) {
  return !!token && safeEqual(csrfTokenFor(sessionId), token);
}
