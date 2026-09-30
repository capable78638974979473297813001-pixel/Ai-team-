import { api, ApiError, readJson } from "@/server/auth/guard";
import { createSession, csrfTokenFor } from "@/server/auth/session";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import { authenticate, loginInput } from "@/server/services/users";

export const POST = api({ auth: false, rate: RULES.auth, rateKey: "auth", csrfToken: false }, async ({ req, meta }) => {
  const input = loginInput.parse(await readJson(req));
  const user = await authenticate(input.email, input.password);
  if (!user) {
    await audit("auth.login_failed", meta, undefined, { email: input.email });
    throw new ApiError(401, "Incorrect email or password", "invalid_credentials");
  }
  const created = await createSession(user.id, meta);
  await audit("auth.login", { userId: user.id, ...meta });
  // API clients send this back as the x-csrf-token header on state-changing requests.
  return { user, csrfToken: csrfTokenFor(created.id) };
});
