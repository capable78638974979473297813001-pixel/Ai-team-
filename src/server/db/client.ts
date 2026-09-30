import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

type GlobalDb = { __aiteamDb?: Db; __aiteamSql?: ReturnType<typeof postgres> };
const g = globalThis as unknown as GlobalDb;

/**
 * Returns the process-wide database handle. Survives Next.js dev hot reloads
 * by caching on globalThis.
 */
export function db(): Db {
  if (!g.__aiteamDb) {
    const url = env().DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured. See README.md → Setup.");
    g.__aiteamSql = postgres(url, { max: 10, prepare: true, onnotice: () => {} });
    g.__aiteamDb = drizzle(g.__aiteamSql, { schema }) as unknown as Db;
  }
  return g.__aiteamDb;
}

/** Tests inject a PGlite-backed database. */
export function setDb(instance: Db) {
  g.__aiteamDb = instance;
}

export { schema };
