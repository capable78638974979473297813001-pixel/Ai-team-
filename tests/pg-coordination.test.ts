import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { bus, type RunEvent } from "@/server/orchestrator/events";
import { startPgCoordination, stopPgCoordination } from "@/server/orchestrator/pg-coordination";

/**
 * Exercises real LISTEN/NOTIFY. Needs a Postgres server:
 *   TEST_DATABASE_URL=postgres://aiteam:aiteam@localhost:5432/aiteam npm test
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("Postgres cross-instance coordination", () => {
  let other: postgres.Sql;
  const cancelled: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    resetEnvCache();
    await startPgCoordination((runId) => cancelled.push(runId));
    other = postgres(url!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await stopPgCoordination();
    await other.end();
  });

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("delivers events published by another instance to local subscribers, but not our own echoes", async () => {
    const got: RunEvent[] = [];
    const off = bus.subscribe("task-1", (e) => got.push(e));
    const event: RunEvent = { type: "delta", taskId: "task-1", agentRunId: "ar", text: "hello" };
    await other.notify("aiteam_events", JSON.stringify({ o: "instance-B", t: "task-1", e: event }));
    await waitFor(() => got.length > 0);
    expect(got).toEqual([event]);

    // Our own publish is delivered locally once, and the NOTIFY echo is ignored.
    bus.publish({ type: "delta", taskId: "task-1", agentRunId: "ar", text: "mine" });
    await new Promise((r) => setTimeout(r, 200));
    expect(got.filter((e) => e.type === "delta" && e.text === "mine")).toHaveLength(1);
    off();
  });

  it("routes cancel requests to the owning instance", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    await other.notify("aiteam_cancel", id);
    await waitFor(() => cancelled.includes(id));
    expect(cancelled).toContain(id);
  });
});
