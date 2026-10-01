import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { agentRuns, messages, providerEvents, taskRuns, tasks } from "../db/schema";
import { reapOrphanedRuns, toAgentRunView, toMessageView, toRunView } from "../orchestrator/runner";
import type { AgentRunView, MessageView, RunView } from "../orchestrator/events";

export function titleFrom(prompt: string) {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 71)}…` : oneLine;
}

export async function createTask(userId: string, prompt: string, teamId: string | null, source: "native" | "import" = "native", title?: string) {
  const [row] = await db()
    .insert(tasks)
    .values({ userId, teamId, title: title ?? titleFrom(prompt), source, status: source === "import" ? "completed" : "idle" })
    .returning();
  return row!;
}

export async function getOwnedTask(userId: string, taskId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return null;
  const [row] = await db().select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  return row ?? null;
}

export type TaskListItem = {
  id: string;
  title: string;
  status: string;
  source: string;
  updatedAt: string;
  providers: string[];
};

export async function listTasks(userId: string, limit = 100): Promise<TaskListItem[]> {
  return (await listTasksPage(userId, { limit })).tasks;
}

/** `u` is the exact (microsecond) updated_at as Postgres prints it, so comparisons stay index-friendly. */
type Cursor = { u: string; id: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s || s.length > 200) return null;
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    return typeof c.u === "string" && /^[0-9 :.+-]{19,40}$/.test(c.u) && /^[0-9a-f-]{36}$/i.test(c.id) ? c : null;
  } catch {
    return null;
  }
}

/** Keyset pagination on (updated_at, id) so pages are stable while tasks keep updating. */
export async function listTasksPage(userId: string, opts: { limit: number; cursor?: string | null }) {
  const cursor = decodeCursor(opts.cursor);
  // The cursor carries Postgres's exact timestamp text (JS Dates would lose microseconds),
  // so these comparisons are exact and the (user_id, updated_at) index serves the ORDER BY.
  // Row-value comparison: Postgres uses it directly as an index condition on (user_id, updated_at, id).
  const after = cursor ? sql`(${tasks.updatedAt}, ${tasks.id}) < (${cursor.u}::timestamptz, ${cursor.id}::uuid)` : undefined;
  const rows = await db()
    .select({ task: tasks, exact: sql<string>`${tasks.updatedAt}::text` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), after))
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > opts.limit && last ? encodeCursor({ u: last.exact, id: last.task.id }) : null;
  return { tasks: await withProviders(page.map((r) => r.task)), nextCursor };
}

async function withProviders(rows: (typeof tasks.$inferSelect)[]): Promise<TaskListItem[]> {
  if (!rows.length) return [];
  const providers = await db()
    .selectDistinct({ taskId: messages.taskId, provider: messages.provider })
    .from(messages)
    .where(and(inArray(messages.taskId, rows.map((r) => r.id)), sql`${messages.provider} is not null`));
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    source: t.source,
    updatedAt: t.updatedAt.toISOString(),
    providers: providers.filter((p) => p.taskId === t.id).map((p) => p.provider!),
  }));
}

export type ActivityItem = { id: string; agentRunId: string | null; provider: string; type: string; data: Record<string, unknown>; createdAt: string };

export type TaskView = {
  task: { id: string; title: string; status: string; source: string; teamId: string | null; createdAt: string };
  runs: (RunView & { roster: { key: string; provider: string; roleTitle: string; isLead: boolean }[] })[];
  messages: MessageView[];
  agentRuns: AgentRunView[];
  activity: ActivityItem[];
};

export async function getTaskView(userId: string, taskId: string): Promise<TaskView | null> {
  const task = await getOwnedTask(userId, taskId);
  if (!task) return null;
  await reapOrphanedRuns(taskId);
  const runs = await db().select().from(taskRuns).where(eq(taskRuns.taskId, taskId)).orderBy(asc(taskRuns.createdAt));
  const runIds = runs.map((r) => r.id);
  const [msgs, ars, events] = await Promise.all([
    db().select().from(messages).where(eq(messages.taskId, taskId)).orderBy(asc(messages.seq)),
    runIds.length ? db().select().from(agentRuns).where(inArray(agentRuns.taskRunId, runIds)).orderBy(asc(agentRuns.createdAt)) : [],
    runIds.length
      ? db()
          .select()
          .from(providerEvents)
          .where(and(inArray(providerEvents.taskRunId, runIds), eq(providerEvents.type, "tool")))
          .orderBy(asc(providerEvents.createdAt))
      : [],
  ]);
  const fresh = (await getOwnedTask(userId, taskId))!;
  return {
    task: {
      id: fresh.id,
      title: fresh.title,
      status: fresh.status,
      source: fresh.source,
      teamId: fresh.teamId,
      createdAt: fresh.createdAt.toISOString(),
    },
    runs: runs.map((r) => ({
      ...toRunView(r),
      roster: r.roster.map((x) => ({ key: x.key, provider: x.provider, roleTitle: x.roleTitle, isLead: x.isLead })),
    })),
    messages: msgs.map(toMessageView),
    agentRuns: ars.map(toAgentRunView),
    activity: events.map((e) => ({
      id: e.id,
      agentRunId: e.agentRunId,
      provider: e.provider,
      type: e.type,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export async function deleteTask(userId: string, taskId: string) {
  const res = await db().delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.userId, userId))).returning({ id: tasks.id });
  return res.length > 0;
}

export async function renameTask(userId: string, taskId: string, title: string) {
  await db().update(tasks).set({ title: title.slice(0, 120) }).where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
}
