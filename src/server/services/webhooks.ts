import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { webhooks } from "../db/schema";
import { env, isProduction } from "../env";
import { decrypt, encrypt, randomToken } from "../security/crypto";
import { log } from "../security/redact";
import { resolveSafeUrl, UnsafeUrlError } from "../security/ssrf";

export const WEBHOOK_EVENTS = ["run.finished"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
const MAX_WEBHOOKS = 10;
const DISABLE_AFTER_FAILURES = 20;
export const webhookTiming = { retryDelaysMs: [1_000, 5_000, 25_000], timeoutMs: 10_000 };

const allowPrivate = () => !isProduction() && env().WEBHOOKS_ALLOW_PRIVATE === "true";
const aad = (id: string) => `webhook:${id}`;

function view(w: typeof webhooks.$inferSelect) {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    disabled: w.disabled,
    consecutiveFailures: w.consecutiveFailures,
    lastStatus: w.lastStatus,
    lastDeliveryAt: w.lastDeliveryAt?.toISOString() ?? null,
    createdAt: w.createdAt.toISOString(),
  };
}

export async function listWebhooks(userId: string) {
  return (await db().select().from(webhooks).where(eq(webhooks.userId, userId)).orderBy(desc(webhooks.createdAt))).map(view);
}

/** Validates the URL now (and again at every delivery). Returns the signing secret once. */
export async function createWebhook(userId: string, url: string, events: WebhookEvent[]) {
  await resolveSafeUrl(url, { allowPrivate: allowPrivate() });
  const [{ n }] = (await db().select({ n: sql<number>`count(*)::int` }).from(webhooks).where(eq(webhooks.userId, userId))) as [{ n: number }];
  if (n >= MAX_WEBHOOKS) throw new UnsafeUrlError(`You can have up to ${MAX_WEBHOOKS} webhooks`);
  const secret = `whsec_${randomToken(32)}`;
  const id = crypto.randomUUID();
  const [row] = await db().insert(webhooks).values({ id, userId, url, events, secretEnc: encrypt(secret, aad(id)) }).returning();
  return { secret, webhook: view(row!) };
}

export async function deleteWebhook(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const res = await db().delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.userId, userId))).returning({ id: webhooks.id });
  return res.length > 0;
}

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` — verify with a constant-time compare and reject old timestamps. */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

type DeliveryResult = { ok: boolean; status: number | null; error?: string };

/** One POST to the pinned, validated address. No redirects; response body discarded. */
async function postOnce(rawUrl: string, body: string, headers: Record<string, string>): Promise<DeliveryResult> {
  let target;
  try {
    target = await resolveSafeUrl(rawUrl, { allowPrivate: allowPrivate() });
  } catch (err) {
    return { ok: false, status: null, error: (err as Error).message };
  }
  const { url, address, family } = target;
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = requester(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        // Connect to the address we validated, never a fresh DNS answer (rebinding protection).
        lookup: (_host, _opts, cb) => cb(null, address, family),
        servername: url.hostname,
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        timeout: webhookTiming.timeoutMs,
      },
      (res) => {
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 64 * 1024) res.destroy();
        });
        res.on("end", () => resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? null }));
        res.on("error", () => resolve({ ok: false, status: res.statusCode ?? null, error: "response error" }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ ok: false, status: null, error: err.message.slice(0, 200) }));
    req.end(body);
  });
}

async function deliverTo(w: typeof webhooks.$inferSelect, event: WebhookEvent, data: Record<string, unknown>, retry = true) {
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify({ id: deliveryId, type: event, createdAt: new Date().toISOString(), data });
  const secret = decrypt(w.secretEnc, aad(w.id));
  let result: DeliveryResult = { ok: false, status: null };
  const attempts = retry ? webhookTiming.retryDelaysMs.length + 1 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, webhookTiming.retryDelaysMs[attempt - 1]));
    result = await postOnce(w.url, body, {
      "content-type": "application/json",
      "user-agent": "AI-Team-Webhooks/1",
      "x-aiteam-event": event,
      "x-aiteam-delivery": deliveryId,
      "x-aiteam-signature": signPayload(secret, body),
    });
    // 4xx (other than 408/429) won't improve with retries.
    if (result.ok || (result.status && result.status >= 400 && result.status < 500 && ![408, 429].includes(result.status))) break;
  }
  const failures = result.ok ? 0 : w.consecutiveFailures + 1;
  await db()
    .update(webhooks)
    .set({
      lastStatus: result.ok ? `ok ${result.status}` : `failed ${result.status ?? ""} ${result.error ?? ""}`.trim().slice(0, 200),
      lastDeliveryAt: new Date(),
      consecutiveFailures: failures,
      disabled: failures >= DISABLE_AFTER_FAILURES,
    })
    .where(eq(webhooks.id, w.id));
  return result;
}

/** Fire-and-forget fan-out to the user's enabled webhooks for an event. */
export function emitWebhook(userId: string, event: WebhookEvent, data: Record<string, unknown>) {
  void (async () => {
    const hooks = await db()
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.userId, userId), eq(webhooks.disabled, false)));
    await Promise.all(hooks.filter((h) => h.events.includes(event)).map((h) => deliverTo(h, event, data)));
  })().catch((err) => log.error("webhook fan-out failed", err));
}

/** Synchronous test delivery for POST /api/webhooks/:id/test. */
export async function testWebhook(userId: string, id: string) {
  const [w] = await db().select().from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));
  if (!w) return null;
  return deliverTo(w, "run.finished", { test: true }, false);
}
