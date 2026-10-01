import { api, ApiError, readJson } from "@/server/auth/guard";
import { createSession, csrfTokenFor } from "@/server/auth/session";
import { audit } from "@/server/security/audit";
import { rateLimit, RULES } from "@/server/security/rate-limit";
import { sha256 } from "@/server/security/crypto";
import { authenticate, loginInput } from "@/server/services/users";

export const POST = api({ auth: false, rate: RULES.auth, rateKey: "auth", csrfToken: false }, async ({ req, meta }) => {
  const input = loginInput.parse(await readJson(req));
  // Per-account throttle on top of the per-IP one, so distributed guessing against one account is slow too.
  const perAccount = await rateLimit(`login-account:${sha256(input.email)}`, { capacity: 10, refillPerSec: 10 / 900 });
  if (!perAccount.ok) {
    throw new ApiError(429, "Too many sign-in attempts for this account. Try again later.", "rate_limited", {
      "retry-after": String(perAccount.retryAfterSec),
    });
  }
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
