import { api, readJson } from "@/server/auth/guard";
import { createSession, csrfTokenFor } from "@/server/auth/session";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import { createUser, signupInput } from "@/server/services/users";
import { ApiError } from "@/server/auth/guard";

export const POST = api({ auth: false, rate: RULES.auth, rateKey: "auth", csrfToken: false }, async ({ req, meta }) => {
  const input = signupInput.parse(await readJson(req));
  const user = await createUser(input);
  if (!user) throw new ApiError(409, "An account with that email already exists", "exists");
  const created = await createSession(user.id, meta);
  await audit("auth.signup", { userId: user.id, ...meta });
  // API clients send this back as the x-csrf-token header on state-changing requests.
  return { user, csrfToken: csrfTokenFor(created.id) };
});
