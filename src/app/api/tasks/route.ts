import { inArray, and, eq } from "drizzle-orm";
import { api, ApiError, readJsonRaw } from "@/server/auth/guard";
import { idempotent } from "@/server/services/idempotency";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { clampLimits } from "@/server/orchestrator/budget";
import { assertRunCapacity, RunCapacityError, startRun } from "@/server/orchestrator/runner";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import type { ProviderId } from "@/server/providers/types";
import { runRequest } from "@/server/services/run-request";
import { createTask, deleteTask, listTasksPage } from "@/server/services/tasks";
import { buildRoster } from "@/server/services/teams";
import { getUserLimits } from "@/server/services/users";

/** Conversations, most recently active first. Paginate with `?limit=` and `?cursor=`. */
export const GET = api({ auth: true }, async ({ req, session }) => {
  const q = new URL(req.url).searchParams;
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  return await listTasksPage(session.user.id, { limit, cursor: q.get("cursor") });
});

export const POST = api({ auth: true, rate: RULES.task, rateKey: "task" }, async ({ req, session, meta }) => {
  const { json, raw } = await readJsonRaw(req, 128 * 1024);
  const body = runRequest.parse(json);
  const userId = session.user.id;
  return idempotent(req, userId, "POST /api/tasks", raw, async () => {
  const limits = clampLimits({ ...(await getUserLimits(userId)), ...(body.limits ?? {}) } as never);

  if (body.contextTaskIds.length) {
    const owned = await db()
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.id, body.contextTaskIds)));
    if (owned.length !== body.contextTaskIds.length) throw new ApiError(404, "Imported conversation not found");
  }

  let roster;
  try {
    roster = await buildRoster(userId, {
      teamId: body.teamId,
      providers: body.providers as ProviderId[] | undefined,
      task: body.prompt,
      maxAgents: limits.maxAgents,
      repoUrl: body.repoUrl,
    });
  } catch (err) {
    throw new ApiError(400, (err as Error).message);
  }
  if (!roster.length) throw new ApiError(400, "Connect at least one AI account first", "no_agents");

  await assertRunCapacity(userId).catch(rethrowCapacity);
  const task = await createTask(userId, body.prompt, body.teamId ?? null);
  const runId = await startRun({
    userId,
    taskId: task.id,
    prompt: body.prompt,
    roster,
    limits,
    options: {
      autoSelect: !body.teamId && !body.providers?.length,
      repoUrl: body.repoUrl ?? null,
      allowPullRequests: body.allowPullRequests,
      contextTaskIds: body.contextTaskIds,
    },
  }).catch(async (err) => {
    // Lost the race for the last run slot: don't leave an empty conversation behind.
    if (err instanceof RunCapacityError) await deleteTask(userId, task.id);
    return rethrowCapacity(err);
  });
  await audit("task.create", { userId, ...meta }, { type: "task", id: task.id }, { agents: roster.map((r) => r.provider) });
  return { taskId: task.id, runId };
  });
});

function rethrowCapacity(err: unknown): never {
  if (err instanceof RunCapacityError) throw new ApiError(429, err.message, "too_many_runs");
  throw err;
}
