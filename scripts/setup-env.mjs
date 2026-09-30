// Generates .env.local with fresh random secrets for local development.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const target = ".env.local";
if (existsSync(target)) {
  console.log(`${target} already exists; leaving it untouched.`);
  process.exit(0);
}
const lines = [
  "APP_URL=http://localhost:3000",
  "DATABASE_URL=postgres://aiteam:aiteam@localhost:5432/aiteam",
  `ENCRYPTION_KEYS=v1:${randomBytes(32).toString("base64")}`,
  `SESSION_SECRET=${randomBytes(32).toString("base64url")}`,
  "ENABLE_SANDBOX_AGENTS=true",
  "# GOOGLE_CLIENT_ID=",
  "# GOOGLE_CLIENT_SECRET=",
  "# GOOGLE_QUOTA_PROJECT=",
  "# OPENAI_SIWC_CLIENT_ID=",
  "",
];
writeFileSync(target, lines.join("\n"), { mode: 0o600 });
console.log(`Wrote ${target}`);
