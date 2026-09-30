import { z } from "zod";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { deleteTask, getTaskView, renameTask } from "@/server/services/tasks";

type P = { id: string };

export const GET = api<true, P>({ auth: true }, async ({ session }, { id }) => {
  const view = await getTaskView(session.user.id, id);
  if (!view) throw new ApiError(404, "Conversation not found");
  return view;
});

export const PATCH = api<true, P>({ auth: true }, async ({ req, session }, { id }) => {
  const body = z.object({ title: z.string().trim().min(1).max(120) }).parse(await readJson(req));
  await renameTask(session.user.id, id, body.title);
  return { ok: true };
});

export const DELETE = api<true, P>({ auth: true }, async ({ session, meta }, { id }) => {
  if (!(await deleteTask(session.user.id, id))) throw new ApiError(404, "Conversation not found");
  await audit("task.delete", { userId: session.user.id, ...meta }, { type: "task", id });
  return { ok: true };
});
