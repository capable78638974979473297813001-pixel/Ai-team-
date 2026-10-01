import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { oauthStates, providerConnections } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { setFetch } from "@/server/providers/http";
import { clearJwksCache } from "@/server/providers/oidc";
import { disconnectProvider, getActiveConnection, listConnections } from "@/server/services/connections";
import { beginOAuth, completeOAuth } from "@/server/services/oauth";
import { freshDb, jsonResponse, makeUser, mockFetch, oidcKeys } from "./helpers";

let d: Db;
const keys = oidcKeys();

function setGoogleEnv() {
  process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.GOOGLE_QUOTA_PROJECT = "aiteam-quota";
  resetEnvCache();
}

function googleMocks(opts: { nonce?: () => string; refreshStatus?: number } = {}) {
  let issuedNonce = "";
  const m = mockFetch({
    "GET https://www.googleapis.com/oauth2/v3/certs": () => jsonResponse(keys.jwks),
    "POST https://oauth2.googleapis.com/token": (_u, init) => {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "refresh_token") {
        if (opts.refreshStatus) return jsonResponse({ error: "invalid_grant" }, opts.refreshStatus);
        return jsonResponse({ access_token: "ya29.refreshed", expires_in: 3600 });
      }
      return jsonResponse({
        access_token: "ya29.access-token-value",
        refresh_token: "1//refresh-token-value",
        expires_in: 3600,
        scope: "openid email https://www.googleapis.com/auth/generative-language.retriever",
        id_token: keys.sign({
          iss: "https://accounts.google.com",
          aud: process.env.GOOGLE_CLIENT_ID,
          sub: "g-1",
          email: "person@example.com",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          nonce: opts.nonce ? opts.nonce() : issuedNonce,
        }),
      });
    },
    "GET https://generativelanguage.googleapis.com/v1beta/models": () =>
      jsonResponse({ models: [{ name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent"] }] }),
    "POST https://oauth2.googleapis.com/revoke": () => new Response(null, { status: 200 }),
  });
  setFetch(m.impl);
  return { m, setNonce: (n: string) => (issuedNonce = n) };
}

async function start(userId: string, sessionId = "sess-1") {
  const url = new URL(await beginOAuth({ userId, sessionId, provider: "google", fields: {} }));
  return { url, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
}

beforeEach(async () => {
  d = await freshDb();
  setGoogleEnv();
  clearJwksCache();
});

describe("Google OAuth (Authorization Code + PKCE + OIDC)", () => {
  it("builds a least-privilege authorization URL with PKCE S256, state, nonce and the exact redirect URI", async () => {
    const user = await makeUser(d);
    const { url } = await start(user.id);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/google/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("scope")).not.toContain("cloud-platform");
    // The raw state and verifier are never stored.
    const [row] = await d.select().from(oauthStates);
    expect(row!.stateHash).not.toBe(q.get("state"));
    expect(row!.codeVerifierEnc).not.toContain(q.get("code_challenge")!);
  });

  it("completes the flow and stores tokens encrypted", async () => {
    const user = await makeUser(d);
    const g = googleMocks();
    const { state, nonce } = await start(user.id);
    g.setNonce(nonce);
    await completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state, code: "auth-code" }) });

    const tokenCall = g.m.calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    const sent = new URLSearchParams(tokenCall.body);
    expect(sent.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(sent.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/google/callback");

    const [row] = await d.select().from(providerConnections).where(eq(providerConnections.userId, user.id));
    expect(row!.accessTokenEnc).not.toContain("ya29");
    expect(row!.refreshTokenEnc).not.toContain("refresh-token-value");
    expect(row!.accountLabel).toBe("person@example.com");
    expect(row!.extra).toEqual({ quotaProject: "aiteam-quota" });

    const view = (await listConnections(user.id)).find((c) => c.provider === "google")!;
    expect(view.state).toBe("connected");
    expect(JSON.stringify(view)).not.toMatch(/ya29|refresh-token-value/);
  });

  it("rejects a reused state (replay)", async () => {
    const user = await makeUser(d);
    const g = googleMocks();
    const { state, nonce } = await start(user.id);
    g.setNonce(nonce);
    const params = new URLSearchParams({ state, code: "c" });
    await completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params });
    await expect(completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params })).rejects.toMatchObject({ code: "state_invalid" });
  });

  it("rejects a state from another session, another user, another provider, or after expiry", async () => {
    const user = await makeUser(d);
    const other = await makeUser(d);
    googleMocks();
    const { state } = await start(user.id);
    const p = new URLSearchParams({ state, code: "c" });
    await expect(completeOAuth({ userId: user.id, sessionId: "other-session", provider: "google", params: p })).rejects.toMatchObject({ code: "state_invalid" });
    await expect(completeOAuth({ userId: other.id, sessionId: "sess-1", provider: "google", params: p })).rejects.toMatchObject({ code: "state_invalid" });
    await expect(completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "openai", params: p })).rejects.toMatchObject({ code: "state_invalid" });

    const s2 = await start(user.id);
    await d.update(oauthStates).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(
      completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state: s2.state, code: "c" }) }),
    ).rejects.toMatchObject({ code: "state_invalid" });
  });

  it("rejects an ID token with the wrong nonce", async () => {
    const user = await makeUser(d);
    googleMocks({ nonce: () => "attacker-nonce" });
    const { state } = await start(user.id);
    await expect(
      completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state, code: "c" }) }),
    ).rejects.toThrow(/nonce/);
    expect(await d.select().from(providerConnections)).toHaveLength(0);
  });

  it("reports the user declining access", async () => {
    const user = await makeUser(d);
    const { state } = await start(user.id);
    await expect(
      completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state, error: "access_denied" }) }),
    ).rejects.toMatchObject({ code: "provider_denied" });
  });

  it("refreshes tokens near expiry, and marks the connection expired if refresh is refused", async () => {
    const user = await makeUser(d);
    const g = googleMocks();
    const { state, nonce } = await start(user.id);
    g.setNonce(nonce);
    await completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state, code: "c" }) });

    await d.update(providerConnections).set({ tokenExpiresAt: new Date(Date.now() + 5_000) });
    const conn = await getActiveConnection(user.id, "google");
    expect(conn!.credentials.accessToken).toBe("ya29.refreshed");

    googleMocks({ refreshStatus: 400 });
    await d.update(providerConnections).set({ tokenExpiresAt: new Date(Date.now() - 1_000) });
    expect(await getActiveConnection(user.id, "google")).toBeNull();
    expect((await listConnections(user.id)).find((c) => c.provider === "google")!.state).toBe("expired");
  });

  it("revokes the grant with Google on disconnect", async () => {
    const user = await makeUser(d);
    const g = googleMocks();
    const { state, nonce } = await start(user.id);
    g.setNonce(nonce);
    await completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state, code: "c" }) });
    await disconnectProvider(user.id, "google");
    const revoke = g.m.calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(revoke!.body).get("token")).toBe("1//refresh-token-value");
    expect(await d.select().from(providerConnections)).toHaveLength(0);
  });

  it("refuses to start OAuth for providers that don't allow it", async () => {
    const user = await makeUser(d);
    await expect(beginOAuth({ userId: user.id, sessionId: "s", provider: "anthropic", fields: {} })).rejects.toMatchObject({ code: "unavailable" });
    await expect(beginOAuth({ userId: user.id, sessionId: "s", provider: "xai", fields: {} })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("refresh concurrency", () => {
  it("refreshes once when parallel agents hit an expiring token", async () => {
    const user = await makeUser(d);
    const g = googleMocks();
    const { state, nonce } = await start(user.id);
    g.setNonce(nonce);
    await completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state, code: "c" }) });
    await d.update(providerConnections).set({ tokenExpiresAt: new Date(Date.now() + 1_000) });
    const results = await Promise.all([1, 2, 3].map(() => getActiveConnection(user.id, "google")));
    expect(results.every((r) => r?.credentials.accessToken === "ya29.refreshed")).toBe(true);
    const refreshes = g.m.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token" && c.body.includes("refresh_token"));
    expect(refreshes).toHaveLength(1);
  });
});

describe("refresh failure handling", () => {
  it("keeps the connection when a refresh fails transiently", async () => {
    const user = await makeUser(d);
    const g = googleMocks();
    const { state, nonce } = await start(user.id);
    g.setNonce(nonce);
    await completeOAuth({ userId: user.id, sessionId: "sess-1", provider: "google", params: new URLSearchParams({ state, code: "c" }) });

    googleMocks({ refreshStatus: 503 });
    // Still valid for 30s: the current token is used.
    await d.update(providerConnections).set({ tokenExpiresAt: new Date(Date.now() + 30_000) });
    const conn = await getActiveConnection(user.id, "google");
    expect(conn!.credentials.accessToken).toBe("ya29.access-token-value");
    // Already expired: skipped for now, but not marked expired.
    await d.update(providerConnections).set({ tokenExpiresAt: new Date(Date.now() - 1_000) });
    expect(await getActiveConnection(user.id, "google")).toBeNull();
    expect((await listConnections(user.id)).find((c) => c.provider === "google")!.state).not.toBe("expired");
  });
});
