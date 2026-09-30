import { lt } from "drizzle-orm";
import { pruneExpiredSessions } from "./auth/session";
import { db } from "./db/client";
import { oauthStates } from "./db/schema";
import { distributed, env } from "./env";
import { INSTANCE_ID } from "./instance";
import { startPgCoordination, stopPgCoordination } from "./orchestrator/pg-coordination";
import { cancelRun, reapOrphanedRuns, shutdownRuns } from "./orchestrator/runner";
import { pruneRateLimits } from "./security/rate-limit";
import { log } from "./security/redact";

const MAINTENANCE_MS = 10 * 60_000;
const g = globalThis as unknown as { __aiteamLifecycle?: boolean };

/** Periodic housekeeping; safe to run on every instance concurrently. */
export async function maintenance() {
  await pruneExpiredSessions();
  await db().delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await pruneRateLimits();
  const reaped = await reapOrphanedRuns();
  if (reaped) log.info(`marked ${reaped} orphaned run(s) as interrupted`);
}

/** Called once per server process from instrumentation.ts. */
export async function startLifecycle() {
  if (g.__aiteamLifecycle) return;
  g.__aiteamLifecycle = true;
  env(); // fail fast on invalid configuration

  if (distributed("EVENT_BUS")) {
    await startPgCoordination((runId) => cancelRun(runId));
  }

  const timer = setInterval(() => void maintenance().catch((err) => log.error("maintenance failed", err)), MAINTENANCE_MS);
  timer.unref?.();

  // Next only lets us own SIGTERM/SIGINT when NEXT_MANUAL_SIG_HANDLE is set (see package.json "start").
  if (process.env.NEXT_MANUAL_SIG_HANDLE) {
    let stopping = false;
    const stop = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      log.info(`${signal}: stopping instance ${INSTANCE_ID}`);
      clearInterval(timer);
      await shutdownRuns();
      await stopPgCoordination().catch(() => {});
      process.exit(0);
    };
    process.on("SIGTERM", () => void stop("SIGTERM"));
    process.on("SIGINT", () => void stop("SIGINT"));
  }
}
