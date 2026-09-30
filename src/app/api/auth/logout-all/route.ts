import { api } from "@/server/auth/guard";
import { destroyAllSessions, destroySession } from "@/server/auth/session";
import { audit } from "@/server/security/audit";

export const POST = api({ auth: true }, async ({ session, meta }) => {
  await destroyAllSessions(session.user.id);
  await destroySession(session.id);
  await audit("auth.logout_all", { userId: session.user.id, ...meta });
  return { ok: true };
});
