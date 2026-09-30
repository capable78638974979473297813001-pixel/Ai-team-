import { describe, expect, it } from "vitest";
import { checkOrigin } from "@/server/auth/guard";
import { csrfTokenFor, verifyCsrf } from "@/server/auth/session";
import { decrypt, encrypt, resetKeyring } from "@/server/security/crypto";
import { hashPassword, verifyPassword } from "@/server/security/password";
import { codeChallengeS256, createCodeVerifier } from "@/server/security/pkce";
import { rateLimit, resetRateLimits } from "@/server/security/rate-limit";
import { redact, redactString } from "@/server/security/redact";
import { resetEnvCache } from "@/server/env";
import { randomBytes } from "node:crypto";

describe("token encryption", () => {
  it("round-trips and binds ciphertext to its associated data", () => {
    const ct = encrypt("sk-secret-value", "user1:openai:access");
    expect(ct).not.toContain("sk-secret");
    expect(decrypt(ct, "user1:openai:access")).toBe("sk-secret-value");
    expect(() => decrypt(ct, "user2:openai:access")).toThrow();
    expect(() => decrypt(ct, "user1:openai:refresh")).toThrow();
  });

  it("detects tampering", () => {
    const ct = encrypt("value", "aad");
    const parts = ct.split(".");
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = body[0]! ^ 1;
    parts[3] = body.toString("base64url");
    expect(() => decrypt(parts.join("."), "aad")).toThrow();
  });

  it("uses fresh IVs", () => {
    expect(encrypt("same", "a")).not.toBe(encrypt("same", "a"));
  });

  it("supports key rotation: old ciphertexts still decrypt after a new key is prepended", () => {
    const old = process.env.ENCRYPTION_KEYS!;
    const oldOnly = old.split(",")[1]!; // v1
    process.env.ENCRYPTION_KEYS = oldOnly;
    resetEnvCache();
    resetKeyring();
    const ct = encrypt("rotating", "aad");
    expect(ct.startsWith("v1.")).toBe(true);
    process.env.ENCRYPTION_KEYS = `v3:${randomBytes(32).toString("base64")},${oldOnly}`;
    resetEnvCache();
    resetKeyring();
    expect(decrypt(ct, "aad")).toBe("rotating");
    expect(encrypt("new", "aad").startsWith("v3.")).toBe(true);
    process.env.ENCRYPTION_KEYS = old;
    resetEnvCache();
    resetKeyring();
  });
});

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong password", h)).toBe(false);
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("creates verifiers of valid length and charset", () => {
    const v = createCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe("CSRF and origin checks", () => {
  it("binds the CSRF token to the session", () => {
    const t = csrfTokenFor("session-a");
    expect(verifyCsrf("session-a", t)).toBe(true);
    expect(verifyCsrf("session-b", t)).toBe(false);
    expect(verifyCsrf("session-a", null)).toBe(false);
  });
  it("accepts only our own origin", () => {
    const req = (h: Record<string, string>) => new Request("http://localhost:3000/api/x", { method: "POST", headers: h });
    expect(checkOrigin(req({ origin: "http://localhost:3000" }))).toBe(true);
    expect(checkOrigin(req({ origin: "https://evil.example" }))).toBe(false);
    expect(checkOrigin(req({ origin: "http://localhost:3000.evil.example" }))).toBe(false);
    expect(checkOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(checkOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(checkOrigin(req({}))).toBe(false);
  });
});

describe("rate limiting", () => {
  it("allows a burst then refuses until refill", () => {
    resetRateLimits();
    const rule = { capacity: 3, refillPerSec: 1 };
    const t = 1_000_000;
    expect([1, 2, 3].map(() => rateLimit("k", rule, t).ok)).toEqual([true, true, true]);
    const blocked = rateLimit("k", rule, t);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(rateLimit("k", rule, t + 1500).ok).toBe(true);
    expect(rateLimit("other", rule, t).ok).toBe(true);
  });
});

describe("redaction", () => {
  it("removes credentials from strings and objects", () => {
    expect(redactString("key sk-proj-abcdefghijklmnop123 here")).not.toContain("abcdefghijklmnop");
    expect(redactString("Authorization: Bearer abc.def.ghi")).toContain("[REDACTED]");
    expect(redactString("xai-1234567890abcdefXYZ")).toBe("[REDACTED]");
    const out = redact({ access_token: "t", nested: { apiKey: "k", ok: "fine" }, refreshToken: "r" }) as any;
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refreshToken).toBe("[REDACTED]");
    expect(out.nested.apiKey).toBe("[REDACTED]");
    expect(out.nested.ok).toBe("fine");
  });
});
