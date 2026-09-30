import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requestMeta } from "@/server/auth/guard";
import { lookupSession, sessionCookieName } from "@/server/auth/session";
import { audit } from "@/server/security/audit";
import { rateLimit, RULES } from "@/server/security/rate-limit";
import { isProviderId } from "@/server/providers/registry";
import { listConnections } from "@/server/services/connections";
import { completeOAuth, OAuthFlowError } from "@/server/services/oauth";

/**
 * OAuth redirect target (registered exactly as `${APP_URL}/api/oauth/<provider>/callback`).
 * CSRF protection here is the `state` parameter: single-use, 10-minute expiry,
 * and bound to the signed-in user *and* their current session.
 * The response never contains tokens — only the resulting connection view.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const meta = requestMeta(req);
  if (!isProviderId(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  if (!rateLimit(`oauth-callback:${meta.ip}`, RULES.connect).ok) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const session = await lookupSession((await cookies()).get(sessionCookieName())?.value ?? null);
  if (!session) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  try {
    await completeOAuth({ userId: session.user.id, sessionId: session.id, provider, params: new URL(req.url).searchParams });
    await audit("connection.connect", { userId: session.user.id, ...meta }, { type: "provider", id: provider }, { method: "oauth" });
    const connection = (await listConnections(session.user.id)).find((c) => c.provider === provider);
    return NextResponse.json({ connected: provider, connection });
  } catch (err) {
    const invalidState = err instanceof OAuthFlowError && err.code === "state_invalid";
    await audit(
      invalidState ? "connection.oauth_state_invalid" : "connection.connect_failed",
      { userId: session.user.id, ...meta },
      { type: "provider", id: provider },
      { method: "oauth" },
    );
    return NextResponse.json(
      { error: err instanceof OAuthFlowError ? err.message : "Sign-in failed", code: err instanceof OAuthFlowError ? err.code : "error" },
      { status: invalidState ? 400 : 502 },
    );
  }
}
