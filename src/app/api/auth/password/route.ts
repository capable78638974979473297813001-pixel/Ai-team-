import { z } from "zod";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import { changePassword } from "@/server/services/account";

export const POST = api({ auth: true, rate: RULES.auth, rateKey: "auth" }, async ({ req, session, meta }) => {
  const body = z
    .object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, "Use at least 10 characters").max(200) })
    .parse(await readJson(req));
  if (!(await changePassword(session.user.id, session.id, body.currentPassword, body.newPassword))) {
    throw new ApiError(401, "Current password is incorrect", "invalid_credentials");
  }
  await audit("auth.password_change", { userId: session.user.id, ...meta });
  return { ok: true };
});
