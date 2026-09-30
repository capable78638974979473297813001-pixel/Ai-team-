import { and, desc, eq, inArray, like } from "drizzle-orm";
import { db } from "../db/client";
import { auditEvents, sessions, taskRuns, tasks, users } from "../db/schema";
import { requestCancel } from "../orchestrator/runner";
import { PROVIDER_IDS } from "../providers/registry";
import { hashPassword, verifyPassword } from "../security/password";
import { disconnectProvider } from "./connections";

/** Public session handle: a prefix of the stored hash (the hash itself can't be used to authenticate). */
const handle = (id: string) => id.slice(0, 16);

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await db().select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.lastSeenAt));
  return rows.map((s) => ({
    id: handle(s.id),
    current: s.id === currentSessionId,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
  }));
}

export async function revokeSession(userId: string, sessionHandle: string) {
  if (!/^[0-9a-f]{16}$/.test(sessionHandle)) return false;
  const res = await db()
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), like(sessions.id, `${sessionHandle}%`)))
    .returning({ id: sessions.id });
  return res.length > 0;
}

export async function changePassword(userId: string, currentSessionId: string, current: string, next: string) {
  const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u || !(await verifyPassword(current, u.hash))) return false;
  await db().update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, userId));
  // Every other session is signed out.
  const others = await db().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
  const ids = others.map((s) => s.id).filter((id) => id !== currentSessionId);
  if (ids.length) await db().delete(sessions).where(inArray(sessions.id, ids));
  return true;
}

export async function listAudit(userId: string, limit = 50) {
  const rows = await db()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.userId, userId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    ip: r.ip,
    userAgent: r.userAgent,
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Delete an account: stop running work, revoke every provider grant that can
 * be revoked, then delete the user (cascading to all their data).
 */
export async function verifyAccountPassword(userId: string, password: string) {
  const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  return !!u && (await verifyPassword(password, u.hash));
}

export async function deleteAccount(userId: string) {
  const running = await db()
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(and(eq(tasks.userId, userId), inArray(taskRuns.status, ["queued", "running"])));
  for (const r of running) await requestCancel(r.id);
  for (const p of PROVIDER_IDS) await disconnectProvider(userId, p);
  await db().delete(users).where(eq(users.id, userId));
}
