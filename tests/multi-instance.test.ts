import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { sessions, taskRuns, tasks, users, providerConnections } from "@/server/db/schema";
import { DEFAULT_LIMITS } from "@/server/orchestrator/budget";
import { awaitRun, beat, reapOrphanedRuns, requestCancel, startRun, STALE_AFTER_MS } from "@/server/orchestrator/runner";
import { runtimeAdapter } from "@/server/providers/registry";
import { sandboxTiming } from "@/server/providers/sandbox";
import { rateLimitPostgres } from "@/server/security/rate-limit";
import { hashPassword } from "@/server/security/password";
import { changePassword, deleteAccount, listSessions, revokeSession, verifyAccountPassword } from "@/server/services/account";
import { saveConnection } from "@/server/services/connections";
import { createTask } from "@/server/services/tasks";
import { buildRoster } from "@/server/services/teams";
import { freshDb, makeUser } from "./helpers";

let d: Db;
beforeAll(() => {
  sandboxTiming.tokenDelayMs = 0;
});
beforeEach(async () => {
  d = await freshDb();
});

async function foreignRun(userId: string, heartbeatAgoMs: number | null) {
  const task = await createTask(userId, "x", null);
  await d.update(tasks).set({ status: "running" }).where(eq(tasks.id, task.id));
  const [run] = await d
    .insert(taskRuns)
    .values({
      taskId: task.id,
      prompt: "x",
      status: "running",
      limits: DEFAULT_LIMITS,
      instanceId: "some-other-instance",
      heartbeatAt: heartbeatAgoMs === null ? null : new Date(Date.now() - heartbeatAgoMs),
      createdAt: new Date(Date.now() - 10 * 60_000),
    })
    .returning();
  return { taskId: task.id, runId: run!.id };
}

describe("run ownership across instances", () => {
  it("leaves runs owned by a live instance alone and reaps runs whose owner died", async () => {
    const u = await makeUser(d);
    const alive = await foreignRun(u.id, 5_000);
    const dead = await foreignRun(u.id, STALE_AFTER_MS + 5_000);
    const never = await foreignRun(u.id, null);
    await reapOrphanedRuns();
    const status = async (id: string) => (await d.select().from(taskRuns).where(eq(taskRuns.id, id)))[0]!.status;
    expect(await status(alive.runId)).toBe("running");
    expect(await status(dead.runId)).toBe("failed");
    expect(await status(never.runId)).toBe("failed");
    expect((await d.select().from(tasks).where(eq(tasks.id, dead.taskId)))[0]!.status).toBe("failed");
  });

  it("flags cancellation for runs owned elsewhere", async () => {
    const u = await makeUser(d);
    const r = await foreignRun(u.id, 1_000);
    expect(await requestCancel(r.runId)).toBe(true);
    const [row] = await d.select().from(taskRuns).where(eq(taskRuns.id, r.runId));
    expect(row!.cancelRequestedAt).toBeInstanceOf(Date);
  });

  it("the owning instance picks up a cancel flag on its heartbeat", async () => {
    sandboxTiming.tokenDelayMs = 20;
    try {
      const u = await makeUser(d);
      for (const p of ["openai", "anthropic"] as const) {
        const out = await runtimeAdapter(p, "sandbox").connect({ method: "sandbox" });
        if (out.kind === "connected") await saveConnection(u.id, p, out.credentials, out.account);
      }
      const task = await createTask(u.id, "long task", null);
      const roster = await buildRoster(u.id, { task: "long task", maxAgents: 5 });
      const runId = await startRun({ userId: u.id, taskId: task.id, prompt: "long task", roster, limits: DEFAULT_LIMITS, options: {} });
      await new Promise((r) => setTimeout(r, 100));
      // Simulate another instance's cancel request arriving only via the database.
      await d.update(taskRuns).set({ cancelRequestedAt: new Date() }).where(eq(taskRuns.id, runId));
      await beat();
      await awaitRun(runId);
      const [row] = await d.select().from(taskRuns).where(eq(taskRuns.id, runId));
      expect(row!.status).toBe("cancelled");
      expect(row!.heartbeatAt).toBeInstanceOf(Date);
    } finally {
      sandboxTiming.tokenDelayMs = 0;
    }
  });
});

describe("Postgres rate limiter", () => {
  it("shares one bucket atomically and refuses once empty", async () => {
    const rule = { capacity: 3, refillPerSec: 0.001 };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => rateLimitPostgres("shared-key", rule)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const blocked = results.find((r) => !r.ok)!;
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect((await rateLimitPostgres("another-key", rule)).ok).toBe(true);
  });
});

describe("account management", () => {
  async function userWithSessions() {
    const [u] = await d.insert(users).values({ email: "a@example.com", name: "A", passwordHash: await hashPassword("old password 123") }).returning();
    const exp = new Date(Date.now() + 86_400_000);
    await d.insert(sessions).values([
      { id: "a".repeat(64), userId: u!.id, expiresAt: exp },
      { id: "b".repeat(64), userId: u!.id, expiresAt: exp },
    ]);
    return u!;
  }

  it("lists and revokes sessions by handle", async () => {
    const u = await userWithSessions();
    const list = await listSessions(u.id, "a".repeat(64));
    expect(list.find((s) => s.current)!.id).toBe("a".repeat(16));
    expect(await revokeSession(u.id, "b".repeat(16))).toBe(true);
    expect(await revokeSession(u.id, "not-a-handle")).toBe(false);
    expect(await d.select().from(sessions)).toHaveLength(1);
  });

  it("changing the password signs out every other session", async () => {
    const u = await userWithSessions();
    expect(await changePassword(u.id, "a".repeat(64), "wrong", "new password 456")).toBe(false);
    expect(await changePassword(u.id, "a".repeat(64), "old password 123", "new password 456")).toBe(true);
    expect((await d.select().from(sessions)).map((s) => s.id)).toEqual(["a".repeat(64)]);
    expect(await verifyAccountPassword(u.id, "new password 456")).toBe(true);
  });

  it("deleting the account removes the user and every connection", async () => {
    const u = await userWithSessions();
    const out = await runtimeAdapter("anthropic", "sandbox").connect({ method: "sandbox" });
    if (out.kind === "connected") await saveConnection(u.id, "anthropic", out.credentials, out.account);
    await deleteAccount(u.id);
    expect(await d.select().from(users)).toHaveLength(0);
    expect(await d.select().from(providerConnections)).toHaveLength(0);
    expect(await d.select().from(sessions)).toHaveLength(0);
  });
});

