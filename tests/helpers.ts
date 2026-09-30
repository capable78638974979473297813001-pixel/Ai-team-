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
