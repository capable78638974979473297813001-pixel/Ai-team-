import { api } from "@/server/auth/guard";
import { destroySession } from "@/server/auth/session";
import { audit } from "@/server/security/audit";

export const POST = api({ auth: true, sessionOnly: true }, async ({ session, meta }) => {
  await destroySession(session.id);
  await audit("auth.logout", { userId: session.user.id, ...meta });
  return { ok: true };
});
