import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { appOrigin, env } from "../env";
import { audit } from "../security/audit";
import { rateLimit, RULES, type RateRule } from "../security/rate-limit";
import { log } from "../security/redact";
import { lookupSession, verifyCsrf, type CurrentSession } from "./session";
import { cookies } from "next/headers";
import { sessionCookieName } from "./session";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}

export type RequestMeta = { ip: string; userAgent: string | null };

/**
 * Client IP for rate limiting and audit. Forwarding headers are client-controlled,
 * so they are only honoured when TRUST_PROXY=true (i.e. a proxy overwrites them).
 */
export function requestMeta(req: Request): RequestMeta {
  const trusted = env().TRUST_PROXY === "true";
  const fwd = trusted ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") : null;
  return { ip: fwd || "direct", userAgent: req.headers.get("user-agent") };
}

/**
 * Reject cross-site state-changing requests. Browsers always send Origin on
 * POST/PUT/PATCH/DELETE fetches; a missing or foreign Origin is refused.
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
};

export function api<Auth extends boolean, P = unknown>(
  opts: Options<Auth>,
  handler: (ctx: Ctx<Auth>, params: P) => Promise<Response | unknown>,
) {
  return async (req: Request, context: { params: Promise<P> }) => {
    const meta = requestMeta(req);
    try {
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (mutating && !checkOrigin(req)) {
        await audit("security.csrf_rejected", { ip: meta.ip, userAgent: meta.userAgent }, undefined, {
          reason: "origin",
          path: new URL(req.url).pathname,
        });
        throw new ApiError(403, "Cross-site request refused", "csrf");
      }

      const token = (await cookies()).get(sessionCookieName())?.value ?? null;
      const session = await lookupSession(token);
      if (opts.auth && !session) throw new ApiError(401, "Sign in required", "unauthenticated");

      if (mutating && session && opts.csrfToken !== false && !verifyCsrf(session.id, req.headers.get("x-csrf-token"))) {
        await audit("security.csrf_rejected", { userId: session.user.id, ip: meta.ip }, undefined, {
          reason: "token",
          path: new URL(req.url).pathname,
        });
        throw new ApiError(403, "Invalid CSRF token", "csrf");
      }

      const rule = opts.rate ?? RULES.api;
      const key = `${opts.rateKey ?? new URL(req.url).pathname}:${session?.user.id ?? meta.ip}`;
      const rl = rateLimit(key, rule);
      if (!rl.ok) {
        await audit("security.rate_limited", { userId: session?.user.id, ip: meta.ip }, undefined, { key: opts.rateKey });
        return NextResponse.json(
          { error: "Too many requests. Try again shortly.", code: "rate_limited" },
          { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
        );
      }

      const params = (context?.params ? await context.params : {}) as P;
      const result = await handler({ req, meta, session } as Ctx<Auth>, params);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      }
      if (err instanceof ZodError) {
        return NextResponse.json(
          { error: err.issues[0]?.message ?? "Invalid request", code: "invalid" },
          { status: 400 },
        );
      }
      log.error(`unhandled API error ${req.method} ${new URL(req.url).pathname}`, err);
      return NextResponse.json({ error: "Something went wrong", code: "internal" }, { status: 500 });
    }
  };
}

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError(413, "Request too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError(413, "Request too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "Malformed JSON");
  }
}
