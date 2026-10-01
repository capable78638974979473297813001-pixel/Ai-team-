import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { apiTokens, auditEvents, messages, providerConnections, tasks, users } from "../db/schema";
import { listTeams } from "./teams";
import { listWebhooks } from "./webhooks";

/**
 * Everything we hold about a user, for data portability. Credentials are
 * never included: provider tokens, token hashes and webhook secrets are omitted.
 */
export async function exportAccount(userId: string) {
  const [user] = await db()
    .select({ id: users.id, email: users.email, name: users.name, settings: users.settings, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  const taskRows = await db().select().from(tasks).where(eq(tasks.userId, userId)).orderBy(asc(tasks.createdAt));
  const msgRows = taskRows.length
    ? await db().select().from(messages).where(inArray(messages.taskId, taskRows.map((t) => t.id))).orderBy(asc(messages.seq))
    : [];
  const connections = await db()
    .select({
      provider: providerConnections.provider,
      method: providerConnections.method,
      status: providerConnections.status,
      accountLabel: providerConnections.accountLabel,
      accountInfo: providerConnections.accountInfo,
      scopes: providerConnections.scopes,
      defaultModel: providerConnections.defaultModel,
      createdAt: providerConnections.createdAt,
    })
    .from(providerConnections)
    .where(eq(providerConnections.userId, userId));
  const tokens = await db()
    .select({ name: apiTokens.name, prefix: apiTokens.prefix, scopes: apiTokens.scopes, createdAt: apiTokens.createdAt, expiresAt: apiTokens.expiresAt })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId));
  const audit = await db().select().from(auditEvents).where(eq(auditEvents.userId, userId)).orderBy(asc(auditEvents.createdAt));
  return {
    exportedAt: new Date().toISOString(),
    user,
    connections,
    teams: await listTeams(userId),
    conversations: taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      source: t.source,
      status: t.status,
      createdAt: t.createdAt,
      messages: msgRows
        .filter((m) => m.taskId === t.id)
        .map((m) => ({ authorType: m.authorType, provider: m.provider, model: m.model, roleTitle: m.roleTitle, kind: m.kind, content: m.content, createdAt: m.createdAt })),
    })),
    apiTokens: tokens,
    webhooks: await listWebhooks(userId),
    auditEvents: audit.map((a) => ({ action: a.action, targetType: a.targetType, targetId: a.targetId, ip: a.ip, createdAt: a.createdAt, metadata: a.metadata })),
  };
}
