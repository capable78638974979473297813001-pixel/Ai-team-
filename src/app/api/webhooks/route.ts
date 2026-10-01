import { z } from "zod";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { UnsafeUrlError } from "@/server/security/ssrf";
import { createWebhook, listWebhooks, WEBHOOK_EVENTS } from "@/server/services/webhooks";

export const GET = api({ auth: true }, async ({ session }) => ({ webhooks: await listWebhooks(session.user.id) }));

/**
 * Register a webhook. Session-only: a webhook receives future task results,
 * so a leaked API token must not be able to add an exfiltration endpoint.
 */
export const POST = api({ auth: true, sessionOnly: true }, async ({ req, session, meta }) => {
  const body = z
    .object({ url: z.string().trim().max(2_000), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).default(["run.finished"]) })
    .parse(await readJson(req));
  try {
    const { secret, webhook } = await createWebhook(session.user.id, body.url, body.events);
    await audit("webhook.create", { userId: session.user.id, ...meta }, { type: "webhook", id: webhook.id }, { host: new URL(body.url).host });
    return { secret, ...webhook };
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new ApiError(400, err.message, "unsafe_url");
    throw err;
  }
});
