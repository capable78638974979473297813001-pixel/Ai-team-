import { api, ApiError } from "@/server/auth/guard";
import { RULES } from "@/server/security/rate-limit";
import { testWebhook } from "@/server/services/webhooks";

/** Send one signed test delivery and report the result. */
export const POST = api<true, { id: string }>({ auth: true, rate: RULES.connect, rateKey: "webhook-test" }, async ({ session }, { id }) => {
  const result = await testWebhook(session.user.id, id);
  if (!result) throw new ApiError(404, "Webhook not found");
  return result;
});
