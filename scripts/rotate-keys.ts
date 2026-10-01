/**
 * Re-encrypt stored provider tokens with the newest key in ENCRYPTION_KEYS.
 *   1. Prepend a new key:   ENCRYPTION_KEYS="v2:<new>,v1:<old>"  (deploy)
 *   2. Run:                 npm run keys:rotate            (or --dry-run)
 *   3. When it reports rotated=0 failed=0 on a re-run, drop v1 from ENCRYPTION_KEYS.
 */
import { rotateEncryptionKeys } from "../src/server/security/rotate";

const dryRun = process.argv.includes("--dry-run");
rotateEncryptionKeys({ dryRun })
  .then((r) => {
    console.log(`${dryRun ? "[dry run] " : ""}key=${r.current} connections=${r.total} rotated=${r.rotated} failed=${r.failed}`);
    process.exit(r.failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
