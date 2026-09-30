import { api, ApiError } from "@/server/auth/guard";
import { RULES } from "@/server/security/rate-limit";
import { isProviderId } from "@/server/providers/registry";
import { checkHealth } from "@/server/services/connections";

export const POST = api<true, { provider: string }>({ auth: true, rate: RULES.connect, rateKey: "health" }, async ({ session }, params) => {
  if (!isProviderId(params.provider)) throw new ApiError(404, "Unknown provider");
  return await checkHealth(session.user.id, params.provider);
});
