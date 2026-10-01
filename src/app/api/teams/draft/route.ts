import { z } from "zod";
import { api, readJson } from "@/server/auth/guard";
import { RULES } from "@/server/security/rate-limit";
import { draftTeam } from "@/server/services/team-draft";

/** Propose a team from a natural-language description. Returns a draft; save it with POST /api/teams. */
export const POST = api({ auth: true, rate: RULES.task, rateKey: "team-draft" }, async ({ req, session }) => {
  const body = z.object({ description: z.string().trim().min(3, "Describe the team you want").max(2_000) }).parse(await readJson(req));
  return await draftTeam(session.user.id, body.description);
});
