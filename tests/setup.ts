import { randomBytes } from "node:crypto";

// Deterministic, isolated configuration for every test file.
Object.assign(process.env, {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEYS: `v2:${randomBytes(32).toString("base64")},v1:${randomBytes(32).toString("base64")}`,
  SESSION_SECRET: randomBytes(32).toString("base64url"),
  ENABLE_SANDBOX_AGENTS: "true",
});
