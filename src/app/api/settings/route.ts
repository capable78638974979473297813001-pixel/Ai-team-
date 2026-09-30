import { z } from "zod";
import { api, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { getUserLimits, updateUserLimits } from "@/server/services/users";

export const GET = api({ auth: true }, async ({ session }) => ({ limits: await getUserLimits(session.user.id) }));

export const PUT = api({ auth: true }, async ({ req, session, meta }) => {
  const input = z
    .object({
      limits: z.object({
        maxRounds: z.number().int(),
        maxAgents: z.number().int(),
        maxCalls: z.number().int(),
        maxRuntimeMs: z.number().int(),
        maxCostUsd: z.number().nullable(),
      }),
    })
    .parse(await readJson(req));
  const limits = await updateUserLimits(session.user.id, input.limits);
  await audit("settings.update", { userId: session.user.id, ...meta }, undefined, { limits });
  return { limits };
});
