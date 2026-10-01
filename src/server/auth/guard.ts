import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { appOrigin, env } from "../env";
import { metrics } from "../metrics";
import { audit } from "../security/audit";
import { rateLimit, RULES, type RateRule } from "../security/rate-limit";
import { log } from "../security/redact";
import { lookupSession, sessionCookieName, verifyCsrf, type CurrentSession } from "./session";
import { lookupApiToken } from "./tokens";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export type RequestMeta = { ip: string; userAgent: string | null; requestId: string };

/**
 * Client IP for rate limiting and audit. Forwarding headers are client-controlled,
 * so they are only honoured when TRUST_PROXY=true (i.e. a proxy overwrites them).
 */
export function requestMeta(req: Request): RequestMeta {
  const trusted = env().TRUST_PROXY === "true";
  const fwd = trusted ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") : null;
  const incoming = req.headers.get("x-request-id");
  const requestId = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  return { ip: fwd || "direct", userAgent: req.headers.get("user-agent"), requestId };
}

/**
 * Reject cross-site state-changing requests made with ambient (cookie)
 * credentials. Browsers always send Origin on POST/PUT/PATCH/DELETE fetches;
 * a missing or foreign Origin is refused.
 */
export function checkOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === appOrigin();
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin";
}

type Ctx<Auth extends boolean> = {
  req: Request;
  meta: RequestMeta;
  session: Auth extends true ? CurrentSession : CurrentSession | null;
};

type Options<Auth extends boolean> = {
  auth: Auth;
  rate?: RateRule;
  rateKey?: string;
  /** Login/signup run before a session exists; they rely on the Origin check. */
  csrfToken?: boolean;
  /**
   * Sensitive account actions (token management, password, deletion, OAuth
   * consent) require an interactive cookie session, not a bearer token.
   */
  sessionOnly?: boolean;
  /** Stable label for metrics, e.g. "/api/tasks/[id]". Defaults to the path. */
  route?: string;
};

async function authenticate(req: Request): Promise<{ session: CurrentSession | null; bearer: boolean }> {
  const authz = req.headers.get("authorization");
  if (authz) {
    const m = authz.match(/^Bearer\s+(\S+)$/i);
    if (!m) throw new ApiError(401, "Malformed Authorization header", "unauthenticated");
    const session = await lookupApiToken(m[1]!);
    if (!session) throw new ApiError(401, "Invalid or expired API token", "invalid_token", { "www-authenticate": 'Bearer error="invalid_token"' });
    return { session, bearer: true };
  }
  const token = (await cookies()).get(sessionCookieName())?.value ?? null;
  return { session: await lookupSession(token), bearer: false };
}

export function api<Auth extends boolean, P = unknown>(
  opts: Options<Auth>,
  handler: (ctx: Ctx<Auth>, params: P) => Promise<Response | unknown>,
) {
  return async (req: Request, context: { params: Promise<P> }) => {
    const started = performance.now();
    const meta = requestMeta(req);
    const path = new URL(req.url).pathname;
    const route = opts.route ?? path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
    let userId: string | undefined;
    let res: Response;

    try {
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      const { session, bearer } = await authenticate(req);
      userId = session?.user.id;

      if (!bearer && mutating && !checkOrigin(req)) {
        await audit("security.csrf_rejected", { ip: meta.ip, userAgent: meta.userAgent }, undefined, { reason: "origin", path });
        throw new ApiError(403, "Cross-site request refused", "csrf");
      }
      if (opts.auth && !session) throw new ApiError(401, "Sign in required", "unauthenticated");

      if (session?.kind === "token") {
        if (opts.sessionOnly) throw new ApiError(403, "This action requires an interactive sign-in, not an API token", "session_required");
        if (mutating && !session.scopes.includes("write")) throw new ApiError(403, "This API token is read-only", "insufficient_scope");
      } else if (mutating && session && opts.csrfToken !== false && !verifyCsrf(session.id, req.headers.get("x-csrf-token"))) {
        await audit("security.csrf_rejected", { userId: session.user.id, ip: meta.ip }, undefined, { reason: "token", path });
        throw new ApiError(403, "Invalid CSRF token", "csrf");
      }

      const rule = opts.rate ?? RULES.api;
      const rl = await rateLimit(`${opts.rateKey ?? route}:${session?.user.id ?? meta.ip}`, rule);
      if (!rl.ok) {
        await audit("security.rate_limited", { userId: session?.user.id, ip: meta.ip }, undefined, { key: opts.rateKey ?? route });
        throw new ApiError(429, "Too many requests. Try again shortly.", "rate_limited", { "retry-after": String(rl.retryAfterSec) });
      }

      const params = (context?.params ? await context.params : {}) as P;
      const result = await handler({ req, meta, session } as Ctx<Auth>, params);
      res = result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
    } catch (err) {
      if (err instanceof ApiError) {
        res = NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: err.headers });
      } else if (err instanceof ZodError) {
        const issue = err.issues[0];
        res = NextResponse.json(
          { error: issue?.message ?? "Invalid request", code: "invalid", field: issue?.path.join(".") || undefined },
          { status: 400 },
        );
      } else {
        log.error(`unhandled API error ${req.method} ${path} [${meta.requestId}]`, err);
        res = NextResponse.json({ error: "Something went wrong", code: "internal", requestId: meta.requestId }, { status: 500 });
      }
    }

    res.headers.set("x-request-id", meta.requestId);
    const seconds = (performance.now() - started) / 1000;
    const statusClass = `${Math.floor(res.status / 100)}xx`;
    metrics.httpRequests.inc({ method: req.method, route, status: statusClass });
    // Streaming responses report time-to-headers.
    metrics.httpDuration.observe({ method: req.method, route }, seconds);
    log.access({ id: meta.requestId, method: req.method, route, status: res.status, ms: Math.round(seconds * 1000), user: userId });
    return res;
  };
}

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<unknown> {
  return (await readJsonRaw(req, maxBytes)).json;
}

/** Parsed body plus the raw text (for idempotency hashing). */
export async function readJsonRaw(req: Request, maxBytes = 256 * 1024): Promise<{ json: unknown; raw: string }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError(413, "Request too large");
  const raw = await req.text();
  if (raw.length > maxBytes) throw new ApiError(413, "Request too large");
  if (!raw) return { json: {}, raw };
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    throw new ApiError(400, "Malformed JSON");
  }
}
