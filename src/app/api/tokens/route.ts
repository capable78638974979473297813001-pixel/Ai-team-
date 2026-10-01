import { z } from "zod";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { createApiToken, listApiTokens } from "@/server/auth/tokens";
import { audit } from "@/server/security/audit";

export const GET = api({ auth: true, sessionOnly: true }, async ({ session }) => ({ tokens: await listApiTokens(session.user.id) }));

/** Create a personal access token. The plaintext token is returned once and never again. */
export const POST = api({ auth: true, sessionOnly: true }, async ({ req, session, meta }) => {
  const body = z
    .object({
      name: z.string().trim().min(1, "Name the token").max(80),
      scopes: z.array(z.enum(["read", "write"])).min(1).default(["read", "write"]),
      expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
    })
    .parse(await readJson(req));
  if ((await listApiTokens(session.user.id)).length >= 25) throw new ApiError(400, "You can have up to 25 API tokens");
  const scopes = [...new Set(body.scopes.includes("write") ? ["read", "write"] : ["read"])] as ("read" | "write")[];
  const { token, record } = await createApiToken(session.user.id, body.name, scopes, body.expiresInDays);
  await audit("token.create", { userId: session.user.id, ...meta }, { type: "api_token", id: record.id }, { scopes });
  return { token, ...record };
});
