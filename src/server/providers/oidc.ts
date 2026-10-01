import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";
import { fetchJson } from "./http";

type Jwk = JsonWebKey & { kid?: string; alg?: string };
const jwksCache = new Map<string, { keys: Jwk[]; at: number }>();

const REFETCH_MIN_MS = 60_000;
/** Last forced (unknown-kid) refetch per JWKS URL, so key-ID spraying can't hammer the issuer. */
const lastForced = new Map<string, number>();

async function getJwks(url: string, force = false): Promise<Jwk[]> {
  const hit = jwksCache.get(url);
  if (force) {
    if (hit && Date.now() - (lastForced.get(url) ?? 0) < REFETCH_MIN_MS) return hit.keys;
    lastForced.set(url, Date.now());
  } else if (hit && Date.now() - hit.at < 3_600_000) {
    return hit.keys;
  }
  const body = await fetchJson<{ keys: Jwk[] }>("oidc", url, { timeoutMs: 10_000 });
  jwksCache.set(url, { keys: body.keys, at: Date.now() });
  return body.keys;
}

function b64json(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  [k: string]: unknown;
};

/**
 * Verify an OpenID Connect ID token: RS256 signature against the issuer's JWKS,
 * exact issuer, audience, expiry, and the nonce we generated.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { issuer: string | string[]; audience: string; nonce: string; jwksUri: string },
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const [h, p, s] = parts as [string, string, string];
  const header = b64json(h) as { alg: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`Unsupported ID token algorithm ${header.alg}`);

  let keys = await getJwks(expected.jwksUri);
  // Providers rotate signing keys; an unknown kid triggers one refetch (at most once a minute).
  if (header.kid && !keys.some((k) => k.kid === header.kid)) keys = await getJwks(expected.jwksUri, true);
  const jwk = keys.find((k) => k.kid === header.kid) ?? (!header.kid && keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new Error("ID token signing key not found");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"))) {
    throw new Error("ID token signature invalid");
  }

  const claims = b64json(p) as IdTokenClaims;
  const issuers = Array.isArray(expected.issuer) ? expected.issuer : [expected.issuer];
  if (!issuers.includes(claims.iss)) throw new Error("ID token issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expected.audience)) throw new Error("ID token audience mismatch");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("ID token expired");
  if (claims.nonce !== expected.nonce) throw new Error("ID token nonce mismatch");
  return claims;
}

export function clearJwksCache() {
  jwksCache.clear();
  lastForced.clear();
}
