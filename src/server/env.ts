import { z } from "zod";

/**
 * Server configuration. Parsed once, lazily, so that tests can set
 * process.env before first access. Never import this from client code.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().optional(),
  /** Set to "true" only when running behind a reverse proxy that sets X-Forwarded-For. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),

  /** Comma-separated `version:base64key` pairs. The first entry encrypts; all decrypt. */
  ENCRYPTION_KEYS: z.string().optional(),
  /** Secret used to derive CSRF tokens. */
  SESSION_SECRET: z.string().min(32).optional(),

  /** Clearly-labelled simulated agents for local development. Never on in production. */
  ENABLE_SANDBOX_AGENTS: z.enum(["true", "false"]).optional(),

  OPENAI_SIWC_CLIENT_ID: z.string().optional(),
  OPENAI_SIWC_CLIENT_SECRET: z.string().optional(),
  OPENAI_SIWC_SCOPES: z
    .string()
    .default("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"),
  OPENAI_SIWC_HOST_ID: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_GEMINI_SCOPES: z
    .string()
    .default("openid email https://www.googleapis.com/auth/generative-language.retriever"),
  GOOGLE_QUOTA_PROJECT: z.string().optional(),

  /** Optional JSON map of `provider:model` -> { inputPerMTok, outputPerMTok } in USD. */
  PRICING_JSON: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        "Invalid server configuration: " +
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    cached = parsed.data;
    if (cached.NODE_ENV === "production") {
      if (!cached.ENCRYPTION_KEYS) throw new Error("ENCRYPTION_KEYS is required in production");
      if (!cached.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production");
      if (!cached.APP_URL.startsWith("https://")) throw new Error("APP_URL must be https in production");
    }
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = null;
}

export function isProduction() {
  return env().NODE_ENV === "production";
}

export function sandboxEnabled() {
  const e = env();
  if (e.NODE_ENV === "production") return false;
  return e.ENABLE_SANDBOX_AGENTS !== "false";
}

export function appOrigin() {
  return new URL(env().APP_URL).origin;
}

/** Exact redirect URI registered with a provider. Only ever built from APP_URL. */
export function oauthRedirectUri(provider: string) {
  return `${appOrigin()}/api/oauth/${provider}/callback`;
}

export function secureCookies() {
  return env().APP_URL.startsWith("https://");
}
