import { api, ApiError } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { deleteWebhook } from "@/server/services/webhooks";

export const DELETE = api<true, { id: string }>({ auth: true }, async ({ session, meta }, { id }) => {
  if (!(await deleteWebhook(session.user.id, id))) throw new ApiError(404, "Webhook not found");
  await audit("webhook.delete", { userId: session.user.id, ...meta }, { type: "webhook", id });
  return { ok: true };
});
