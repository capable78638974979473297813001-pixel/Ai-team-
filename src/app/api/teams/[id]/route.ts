import { api, ApiError, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { deleteTeam, saveTeam, teamInput } from "@/server/services/teams";

type P = { id: string };

export const PUT = api<true, P>({ auth: true }, async ({ req, session, meta }, { id }) => {
  const input = teamInput.parse(await readJson(req));
  try {
    await saveTeam(session.user.id, input, id);
  } catch {
    throw new ApiError(404, "Team not found");
  }
  await audit("team.update", { userId: session.user.id, ...meta }, { type: "team", id });
  return { id };
});

export const DELETE = api<true, P>({ auth: true }, async ({ session, meta }, { id }) => {
  if (!(await deleteTeam(session.user.id, id))) throw new ApiError(404, "Team not found");
  await audit("team.delete", { userId: session.user.id, ...meta }, { type: "team", id });
  return { ok: true };
});
