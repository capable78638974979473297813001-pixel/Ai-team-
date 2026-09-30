const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|cookie|code_verifier|^code$/i;
const SECRET_VALUE = [
  /\b(sk|xai|crsr|sk-ant|AIza)[-_A-Za-z0-9]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bya29\.[A-Za-z0-9._-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
];

/** Remove anything that looks like a credential from a string. */
export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_VALUE) out = out.replace(re, "[REDACTED]");
  return out;
}

/** Deep-copy a value with secret-looking keys and values removed. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return "[…]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Logger that can never print provider tokens. */
export const log = {
  info: (msg: string, data?: unknown) => console.log(`[aiteam] ${msg}`, data === undefined ? "" : redact(data)),
  warn: (msg: string, data?: unknown) => console.warn(`[aiteam] ${msg}`, data === undefined ? "" : redact(data)),
  error: (msg: string, err?: unknown) =>
    console.error(`[aiteam] ${msg}`, err instanceof Error ? redactString(err.message) : redact(err)),
};
