import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../db/client";
import { oauthStates } from "../db/schema";
import { oauthRedirectUri } from "../env";
import { decrypt, encrypt, randomToken, sha256 } from "../security/crypto";
import { codeChallengeS256, createCodeVerifier } from "../security/pkce";
import { getAdapter, methodsFor } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { saveConnection } from "./connections";

const STATE_TTL_MS = 10 * 60 * 1000;

export class OAuthFlowError extends Error {
  constructor(
    message: string,
    public code: "state_invalid" | "provider_denied" | "exchange_failed" | "unavailable",
  ) {
    super(message);
  }
}

/**
 * Step 1: create a single-use state bound to this user *and* session, a PKCE
 * verifier (stored encrypted) and an OIDC nonce, then return the provider's
 * authorization URL. The redirect URI is derived from APP_URL only.
 */
export async function beginOAuth(args: {
  userId: string;
  sessionId: string;
  provider: ProviderId;
  fields: Record<string, string>;
}): Promise<string> {
  const method = methodsFor(args.provider).find((m) => m.id === "oauth");
  if (!method || method.availability !== "available") {
    throw new OAuthFlowError(method?.reason ?? "OAuth is not available for this provider", "unavailable");
  }
  // Only keep fields the method declares (e.g. quotaProject) and cap their size.
  const allowed = new Set((method.fields ?? []).map((f) => f.name));
  const fields = Object.fromEntries(
    Object.entries(args.fields)
      .filter(([k, v]) => allowed.has(k) && typeof v === "string")
      .map(([k, v]) => [k, v.trim().slice(0, 100)]),
  );
  if (fields.quotaProject && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(fields.quotaProject)) {
    throw new OAuthFlowError("That doesn't look like a Google Cloud project ID", "unavailable");
  }

  const state = randomToken(32);
  const nonce = randomToken(24);
  const verifier = createCodeVerifier();
  const stateHash = sha256(state);
  const redirectUri = oauthRedirectUri(args.provider);

  await db().delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await db()
    .insert(oauthStates)
    .values({
      stateHash,
      userId: args.userId,
      sessionId: args.sessionId,
      provider: args.provider,
      codeVerifierEnc: encrypt(verifier, `oauth:${stateHash}`),
      nonce,
      redirectUri,
      extra: fields,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });

  const outcome = await getAdapter(args.provider).connect({
    method: "oauth",
    redirectUri,
    state,
    nonce,
    codeChallenge: codeChallengeS256(verifier),
    fields,
  });
  if (outcome.kind !== "redirect") throw new OAuthFlowError("Provider did not return an authorization URL", "unavailable");
  return outcome.url;
}

/**
 * Step 2: validate the callback. The state must exist, match the provider,
 * belong to the same user and session, be unexpired, and not already be used
 * (consumed atomically). Then exchange the code with the PKCE verifier.
 */
export async function completeOAuth(args: {
  userId: string;
  sessionId: string;
  provider: ProviderId;
  params: URLSearchParams;
}) {
  const state = args.params.get("state");
  if (!state || state.length > 200) throw new OAuthFlowError("Missing authorization state", "state_invalid");
  const stateHash = sha256(state);

  const [row] = await db()
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthStates.stateHash, stateHash),
        eq(oauthStates.provider, args.provider),
        eq(oauthStates.userId, args.userId),
        eq(oauthStates.sessionId, args.sessionId),
        isNull(oauthStates.consumedAt),
        gt(oauthStates.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) throw new OAuthFlowError("This sign-in link is invalid or has expired. Please try again.", "state_invalid");

  const providerError = args.params.get("error");
  if (providerError) {
    throw new OAuthFlowError(
      providerError === "access_denied" ? "You declined access." : `The provider returned an error (${providerError.slice(0, 60)}).`,
      "provider_denied",
    );
  }
  const code = args.params.get("code");
  if (!code) throw new OAuthFlowError("The provider did not return an authorization code", "exchange_failed");

  // Defence in depth: the stored redirect URI must still be exactly what we derive.
  if (row.redirectUri !== oauthRedirectUri(args.provider)) {
    throw new OAuthFlowError("Redirect URI mismatch", "state_invalid");
  }

  const adapter = getAdapter(args.provider);
  if (!adapter.completeOAuth) throw new OAuthFlowError("Provider does not support OAuth", "unavailable");
  try {
    const { credentials, account } = await adapter.completeOAuth({
      code,
      redirectUri: row.redirectUri,
      codeVerifier: decrypt(row.codeVerifierEnc, `oauth:${stateHash}`),
      nonce: row.nonce,
      params: args.params,
      fields: row.extra,
    });
    await saveConnection(args.userId, args.provider, credentials, account);
    return account;
  } catch (err) {
    throw new OAuthFlowError(
      `Could not complete sign-in: ${err instanceof Error ? err.message : "unknown error"}`.slice(0, 300),
      "exchange_failed",
    );
  }
}
