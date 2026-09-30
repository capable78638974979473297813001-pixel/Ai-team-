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
  const rows = await db().select().from(tasks).where(eq(tasks.userId, userId)).orderBy(desc(tasks.updatedAt)).limit(limit);
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
