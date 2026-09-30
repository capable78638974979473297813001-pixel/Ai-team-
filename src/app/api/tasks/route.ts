import { inArray, and, eq } from "drizzle-orm";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { clampLimits } from "@/server/orchestrator/budget";
import { startRun } from "@/server/orchestrator/runner";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import type { ProviderId } from "@/server/providers/types";
import { runRequest } from "@/server/services/run-request";
import { createTask, listTasks } from "@/server/services/tasks";
import { buildRoster } from "@/server/services/teams";
import { getUserLimits } from "@/server/services/users";

export const GET = api({ auth: true }, async ({ session }) => ({ tasks: await listTasks(session.user.id) }));

export const POST = api({ auth: true, rate: RULES.task, rateKey: "task" }, async ({ req, session, meta }) => {
  const body = runRequest.parse(await readJson(req, 128 * 1024));
  const userId = session.user.id;
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
  });
  await audit("task.create", { userId, ...meta }, { type: "task", id: task.id }, { agents: roster.map((r) => r.provider) });
  return { taskId: task.id, runId };
});
