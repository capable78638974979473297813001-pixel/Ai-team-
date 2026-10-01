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

/**
 * Logger that can never print provider tokens. In production (or with
 * LOG_FORMAT=json) every line is a single JSON object for log pipelines.
 */
const json = () => process.env.LOG_FORMAT === "json" || (process.env.NODE_ENV === "production" && process.env.LOG_FORMAT !== "text");

function emit(level: "info" | "warn" | "error", msg: string, data?: unknown) {
  const clean = data === undefined ? undefined : data instanceof Error ? redactString(data.message) : redact(data);
  if (json()) {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg: redactString(msg), ...(clean === undefined ? {} : { data: clean }) });
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  } else {
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[aiteam] ${redactString(msg)}`, clean ?? "");
  }
}

export const log = {
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  error: (msg: string, err?: unknown) => emit("error", msg, err),
  /** One line per API request. Never includes bodies, headers or query strings. */
  access: (fields: { id: string; method: string; route: string; status: number; ms: number; user?: string }) => {
    if (json()) console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "request", ...fields }));
    else if (process.env.LOG_ACCESS === "true") console.log(`[aiteam] ${fields.method} ${fields.route} ${fields.status} ${fields.ms}ms ${fields.id}`);
  },
};
