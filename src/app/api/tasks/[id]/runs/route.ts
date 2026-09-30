import { and, desc, eq, inArray } from "drizzle-orm";
import { tasks } from "@/server/db/schema";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { db } from "@/server/db/client";
import { taskRuns } from "@/server/db/schema";
import { clampLimits } from "@/server/orchestrator/budget";
import { reapOrphanedRuns, startRun } from "@/server/orchestrator/runner";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import type { ProviderId } from "@/server/providers/types";
import { runRequest } from "@/server/services/run-request";
import { getOwnedTask } from "@/server/services/tasks";
import { buildRoster } from "@/server/services/teams";
import { getUserLimits } from "@/server/services/users";

/** Follow-up message in an existing conversation: starts a new run with prior context. */
export const POST = api<true, { id: string }>({ auth: true, rate: RULES.task, rateKey: "task" }, async ({ req, session, meta }, { id }) => {
  const userId = session.user.id;
  const task = await getOwnedTask(userId, id);
  if (!task) throw new ApiError(404, "Conversation not found");
  const body = runRequest.parse(await readJson(req, 128 * 1024));

  if (body.contextTaskIds.length) {
    const owned = await db()
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.id, body.contextTaskIds)));
    if (owned.length !== body.contextTaskIds.length) throw new ApiError(404, "Imported conversation not found");
  }

  await reapOrphanedRuns(id);
  const busy = await db()
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(and(eq(taskRuns.taskId, id), inArray(taskRuns.status, ["queued", "running"])));
  if (busy.length) throw new ApiError(409, "The team is still working on the previous message");

  const [previous] = await db().select().from(taskRuns).where(eq(taskRuns.taskId, id)).orderBy(desc(taskRuns.createdAt)).limit(1);
  const limits = clampLimits({ ...(await getUserLimits(userId)), ...(body.limits ?? {}) } as never);
  const teamId = body.teamId ?? task.teamId;
  const providers = (body.providers?.length ? body.providers : previous?.roster.map((r) => r.provider)) as ProviderId[] | undefined;
  const roster = teamId
    ? await buildRoster(userId, { teamId, task: body.prompt, maxAgents: limits.maxAgents, repoUrl: body.repoUrl })
    : await buildRoster(userId, { providers, task: body.prompt, maxAgents: limits.maxAgents, repoUrl: body.repoUrl ?? previous?.options.repoUrl });
  if (!roster.length) throw new ApiError(400, "Connect at least one AI account first", "no_agents");

  const runId = await startRun({
    userId,
    taskId: id,
    prompt: body.prompt,
    roster,
    limits,
    options: {
      repoUrl: body.repoUrl ?? previous?.options.repoUrl ?? null,
      allowPullRequests: body.allowPullRequests,
      contextTaskIds: body.contextTaskIds.length ? body.contextTaskIds : (previous?.options.contextTaskIds ?? []),
    },
  });
  await audit("task.run", { userId, ...meta }, { type: "task", id });
  return { runId };
});
