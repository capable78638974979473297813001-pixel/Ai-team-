import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 code verifier: 43–128 chars from the unreserved set. */
export function createCodeVerifier() {
  return randomBytes(48).toString("base64url"); // 64 chars
}

export function codeChallengeS256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}
