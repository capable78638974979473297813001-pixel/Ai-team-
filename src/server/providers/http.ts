import { redactString } from "../security/redact";
import { AuthExpiredError, ProviderError } from "./types";

export type FetchLike = typeof fetch;

/** Tests swap this out; production uses global fetch. */
let fetchImpl: FetchLike = (...args) => fetch(...args);
export function setFetch(f: FetchLike) {
  fetchImpl = f;
}
export function providerFetch(input: string | URL, init?: RequestInit) {
  return fetchImpl(input, init);
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function withTimeout(signal: AbortSignal | undefined, ms = DEFAULT_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Turn a non-2xx response into a sanitised ProviderError (never includes request headers). */
export async function toProviderError(provider: string, res: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      detail = body?.error?.message ?? body?.error_description ?? body?.message ?? body?.error ?? "";
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch {
      detail = text.slice(0, 300);
    }
  } catch {
    /* ignore */
  }
  const msg = redactString(`${provider} returned ${res.status}${detail ? `: ${detail}` : ""}`).slice(0, 500);
  if (res.status === 401) return new AuthExpiredError(msg) as unknown as ProviderError;
  return new ProviderError(provider, res.status, msg, res.status === 429 || res.status >= 500);
}

export async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const res = await providerFetch(url, { ...init, signal: withTimeout(init.signal ?? undefined, init.timeoutMs) });
  if (!res.ok) throw await toProviderError(provider, res);
  return (await res.json()) as T;
}

export type SSEEvent = { event: string | null; data: string };

/** Minimal, spec-compliant-enough Server-Sent Events parser. */
export async function* parseSSE(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SSEEvent> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = null;
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = val;
          else if (field === "data") data.push(val);
        }
      }
    }
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

export function formBody(params: Record<string, string | undefined>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  return body;
}
