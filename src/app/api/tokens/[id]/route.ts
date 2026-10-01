import { api, ApiError } from "@/server/auth/guard";
import { revokeApiToken } from "@/server/auth/tokens";
import { audit } from "@/server/security/audit";

export const DELETE = api<true, { id: string }>({ auth: true, sessionOnly: true }, async ({ session, meta }, { id }) => {
  if (!(await revokeApiToken(session.user.id, id))) throw new ApiError(404, "Token not found");
  await audit("token.revoke", { userId: session.user.id, ...meta }, { type: "api_token", id });
  return { ok: true };
});
