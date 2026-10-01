import { cookies } from "next/headers";
import { z } from "zod";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { sessionCookieName } from "@/server/auth/session";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import { deleteAccount, verifyAccountPassword } from "@/server/services/account";

/** Permanently delete the account. Requires the password again. */
export const DELETE = api({ auth: true, sessionOnly: true, rate: RULES.auth, rateKey: "auth" }, async ({ req, session, meta }) => {
  const body = z.object({ password: z.string().min(1).max(200) }).parse(await readJson(req));
  if (!(await verifyAccountPassword(session.user.id, body.password))) {
    throw new ApiError(401, "Password is incorrect", "invalid_credentials");
  }
  // Recorded before deletion; the row's user_id becomes NULL once the user is gone.
  await audit("account.delete", { userId: session.user.id, ...meta }, { type: "user", id: session.user.id });
  await deleteAccount(session.user.id);
  (await cookies()).delete(sessionCookieName());
  return { ok: true };
});
