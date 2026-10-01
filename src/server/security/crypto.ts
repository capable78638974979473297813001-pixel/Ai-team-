import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env";

/**
 * Envelope format: `<keyVersion>.<iv>.<authTag>.<ciphertext>` (base64url parts).
 * AES-256-GCM with a 96-bit random IV and caller-supplied associated data (AAD)
 * so a ciphertext copied to another row/field fails to decrypt.
 */

type Keyring = { current: string; keys: Map<string, Buffer> };
let keyring: Keyring | null = null;

const DEV_FALLBACK_KEY = createHash("sha256").update("aiteam-insecure-development-key").digest();

function loadKeyring(): Keyring {
  if (keyring) return keyring;
  const raw = env().ENCRYPTION_KEYS;
  const keys = new Map<string, Buffer>();
  let current = "";
  if (!raw) {
    if (env().NODE_ENV === "production") throw new Error("ENCRYPTION_KEYS is required");
    console.warn("[security] ENCRYPTION_KEYS not set — using an insecure development key. Run `npm run setup`.");
    keys.set("dev", DEV_FALLBACK_KEY);
    current = "dev";
  } else {
    for (const part of raw.split(",")) {
      const [version, b64] = part.trim().split(":");
      if (!version || !b64) throw new Error("ENCRYPTION_KEYS entries must be `version:base64key`");
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new Error(`Encryption key ${version} must be 32 bytes`);
      keys.set(version, key);
      if (!current) current = version;
    }
  }
  keyring = { current, keys };
  return keyring;
}

/** Version of the key new ciphertexts are written with. */
export function currentKeyVersion() {
  return loadKeyring().current;
}

/** Key version recorded in a ciphertext envelope. */
export function envelopeKeyVersion(envelope: string) {
  return envelope.split(".")[0] ?? "";
}

export function resetKeyring() {
  keyring = null;
}

export function encrypt(plaintext: string, aad: string): string {
  const { current, keys } = loadKeyring();
  const key = keys.get(current)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [current, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(envelope: string, aad: string): string {
  const { keys } = loadKeyring();
  const [version, ivB64, tagB64, ctB64] = envelope.split(".");
  const key = version ? keys.get(version) : undefined;
  if (!key || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Unreadable ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(value: string) {
  const secret = env().SESSION_SECRET ?? "aiteam-insecure-development-session-secret";
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
