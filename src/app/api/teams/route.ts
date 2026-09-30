import { api, ApiError, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { listTeams, saveTeam, teamInput } from "@/server/services/teams";

export const GET = api({ auth: true }, async ({ session }) => ({ teams: await listTeams(session.user.id) }));

export const POST = api({ auth: true }, async ({ req, session, meta }) => {
  const input = teamInput.parse(await readJson(req));
  const count = (await listTeams(session.user.id)).length;
  if (count >= 50) throw new ApiError(400, "You can have up to 50 teams");
  const id = await saveTeam(session.user.id, input);
  await audit("team.create", { userId: session.user.id, ...meta }, { type: "team", id });
  return { id };
});
