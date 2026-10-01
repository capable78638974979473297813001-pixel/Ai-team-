import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { providerConnections } from "../db/schema";
import { currentKeyVersion, decrypt, encrypt, envelopeKeyVersion } from "./crypto";

/**
 * Re-encrypt every stored provider credential with the current (first) key in
 * ENCRYPTION_KEYS. Run after prepending a new key; once it reports zero
 * remaining, the old key can be removed from ENCRYPTION_KEYS.
 */
export async function rotateEncryptionKeys(opts: { dryRun?: boolean } = {}) {
  const current = currentKeyVersion();
  const rows = await db().select().from(providerConnections);
  let rotated = 0;
  let failed = 0;
  for (const r of rows) {
    const patch: { accessTokenEnc?: string; refreshTokenEnc?: string } = {};
    try {
      for (const [field, col] of [
        ["access", "accessTokenEnc"],
        ["refresh", "refreshTokenEnc"],
      ] as const) {
        const ct = r[col];
        if (!ct || envelopeKeyVersion(ct) === current) continue;
        const aad = `${r.userId}:${r.provider}:${field}`;
        patch[col] = encrypt(decrypt(ct, aad), aad);
      }
    } catch {
      failed++;
      continue;
    }
    if (!Object.keys(patch).length) continue;
    if (!opts.dryRun) await db().update(providerConnections).set(patch).where(eq(providerConnections.id, r.id));
    rotated++;
  }
  return { current, total: rows.length, rotated, failed };
}
