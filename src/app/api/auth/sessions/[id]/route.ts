import { api, ApiError } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { revokeSession } from "@/server/services/account";

export const DELETE = api<true, { id: string }>({ auth: true, sessionOnly: true }, async ({ session, meta }, { id }) => {
  if (!(await revokeSession(session.user.id, id))) throw new ApiError(404, "Session not found");
  await audit("auth.session_revoke", { userId: session.user.id, ...meta }, { type: "session", id });
  return { ok: true };
});
