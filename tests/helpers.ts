import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDb, type Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { users } from "@/server/db/schema";

/** A fresh in-memory Postgres (PGlite) with all migrations applied. */
export async function freshDb(): Promise<Db> {
  const client = new PGlite();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  setDb(d as unknown as Db);
  return d as unknown as Db;
}

export async function makeUser(d: Db, email = `u${Math.random().toString(36).slice(2)}@example.com`) {
  const [u] = await d.insert(users).values({ email, name: "Test", passwordHash: "x" }).returning();
  return u!;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function sseResponse(events: unknown[]) {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

import { createSign, generateKeyPairSync } from "node:crypto";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Route-based fetch mock; records every call. Unmatched requests fail loudly. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    let body = "";
    if (typeof init.body === "string") body = init.body;
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    else if (input instanceof Request) body = await input.clone().text();
    calls.push({ method, url: url.href, headers, body });
    const key = `${method} ${url.origin}${url.pathname}`;
    const handler = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];
    if (!handler) return new Response(JSON.stringify({ error: `unmocked ${key}` }), { status: 599 });
    return handler(url, { ...init, body });
  };
  return { impl: impl as typeof fetch, calls };
}

/** An RSA signing key + JWKS for faking an OIDC provider. */
export function oidcKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const sign = (claims: Record<string, unknown>) => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
    return `${h}.${p}.${s}`;
  };
  return { jwks: { keys: [jwk] }, sign };
}
