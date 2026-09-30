import { and, eq, inArray } from "drizzle-orm";
import { api, ApiError } from "@/server/auth/guard";
import { db } from "@/server/db/client";
import { taskRuns } from "@/server/db/schema";
import { requestCancel } from "@/server/orchestrator/runner";
import { audit } from "@/server/security/audit";
import { getOwnedTask } from "@/server/services/tasks";

export const POST = api<true, { id: string }>({ auth: true }, async ({ session, meta }, { id }) => {
  if (!(await getOwnedTask(session.user.id, id))) throw new ApiError(404, "Conversation not found");
  const runs = await db()
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(and(eq(taskRuns.taskId, id), inArray(taskRuns.status, ["queued", "running"])));
  let cancelled = 0;
  for (const r of runs) if (await requestCancel(r.id)) cancelled++;
  if (cancelled) await audit("task.cancel", { userId: session.user.id, ...meta }, { type: "task", id });
  return { cancelled };
});
