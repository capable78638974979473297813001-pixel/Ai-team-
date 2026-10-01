import { z } from "zod";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import { isProviderId, methodsFor, runtimeAdapter } from "@/server/providers/registry";
import { AuthExpiredError, ProviderError } from "@/server/providers/types";
import { disconnectProvider, listConnections, saveConnection, setDefaultModel } from "@/server/services/connections";
import { beginOAuth, OAuthFlowError } from "@/server/services/oauth";

const connectBody = z.object({
  method: z.enum(["oauth", "api_key", "sandbox"]),
  apiKey: z.string().trim().max(500).optional(),
  fields: z.record(z.string(), z.string().max(200)).default({}),
});

type P = { provider: string };

function provider(p: P) {
  if (!isProviderId(p.provider)) throw new ApiError(404, "Unknown provider");
  return p.provider;
}

export const POST = api<true, P>({ auth: true, rate: RULES.connect, rateKey: "connect" }, async ({ req, session, meta }, params) => {
  const id = provider(params);
  const body = connectBody.parse(await readJson(req));
  const method = methodsFor(id).find((m) => m.id === body.method);
  if (!method) throw new ApiError(400, "That connection method doesn't exist for this provider");
  if (method.availability !== "available") throw new ApiError(400, method.reason ?? "That connection method isn't available", "unavailable");
  const ctx = { userId: session.user.id, ...meta };

  if (body.method === "oauth") {
    if (session.kind !== "cookie") {
      throw new ApiError(403, "Provider sign-in must be started from an interactive session", "session_required");
    }
    try {
      const url = await beginOAuth({ userId: session.user.id, sessionId: session.id, provider: id, fields: body.fields });
      await audit("connection.oauth_started", ctx, { type: "provider", id });
      return { redirect: url };
    } catch (err) {
      if (err instanceof OAuthFlowError) throw new ApiError(400, err.message, err.code);
      throw err;
    }
  }

  if (body.method === "api_key") {
    const key = body.apiKey ?? "";
    if (key.length < 8 || /\s/.test(key)) throw new ApiError(400, "Paste the full API key");
  }

  try {
    const adapter = runtimeAdapter(id, body.method);
    const outcome = await adapter.connect(
      body.method === "api_key" ? { method: "api_key", apiKey: body.apiKey!, fields: body.fields } : { method: "sandbox" },
    );
    if (outcome.kind !== "connected") throw new ApiError(500, "Unexpected connect result");
    await saveConnection(session.user.id, id, outcome.credentials, outcome.account);
    await audit("connection.connect", ctx, { type: "provider", id }, { method: body.method });
    return { connection: (await listConnections(session.user.id)).find((c) => c.provider === id) };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    await audit("connection.connect_failed", ctx, { type: "provider", id }, { method: body.method });
    if (err instanceof AuthExpiredError) throw new ApiError(400, "The provider rejected that key. Check it and try again.", "rejected");
    if (err instanceof ProviderError) throw new ApiError(502, err.message, "provider_error");
    throw err;
  }
});

export const PATCH = api<true, P>({ auth: true }, async ({ req, session }, params) => {
  const id = provider(params);
  const body = z.object({ defaultModel: z.string().trim().min(1).max(120) }).parse(await readJson(req));
  try {
    await setDefaultModel(session.user.id, id, body.defaultModel);
  } catch (err) {
    throw new ApiError(400, (err as Error).message);
  }
  return { ok: true };
});

export const DELETE = api<true, P>({ auth: true, rate: RULES.connect, rateKey: "connect" }, async ({ session, meta }, params) => {
  const id = provider(params);
  const removed = await disconnectProvider(session.user.id, id);
  if (removed) await audit("connection.disconnect", { userId: session.user.id, ...meta }, { type: "provider", id });
  return { ok: true };
});
