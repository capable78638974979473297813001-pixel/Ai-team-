import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { agentRuns, messages, taskRuns, tasks } from "@/server/db/schema";
import { DEFAULT_LIMITS } from "@/server/orchestrator/budget";
import { awaitRun, cancelRun, startRun } from "@/server/orchestrator/runner";
import { getAdapter, runtimeAdapter } from "@/server/providers/registry";
import { sandboxTiming } from "@/server/providers/sandbox";
import type { ProviderId } from "@/server/providers/types";
import { saveConnection } from "@/server/services/connections";
import { createTask } from "@/server/services/tasks";
import { buildRoster } from "@/server/services/teams";
import { freshDb, makeUser } from "./helpers";

let d: Db;

async function connectSandbox(userId: string, providers: ProviderId[]) {
  for (const p of providers) {
    const out = await runtimeAdapter(p, "sandbox").connect({ method: "sandbox" });
    if (out.kind !== "connected") throw new Error("unexpected");
    await saveConnection(userId, p, out.credentials, out.account);
  }
}

async function run(userId: string, prompt: string, limits = DEFAULT_LIMITS, providers?: ProviderId[]) {
  const task = await createTask(userId, prompt, null);
  const roster = await buildRoster(userId, { task: prompt, maxAgents: limits.maxAgents, providers });
  const runId = await startRun({ userId, taskId: task.id, prompt, roster, limits, options: {} });
  return { taskId: task.id, runId };
}

beforeAll(() => {
  sandboxTiming.tokenDelayMs = 0;
});

beforeEach(async () => {
  d = await freshDb();
});

describe("orchestrator (sandbox agents)", () => {
  it("runs plan → delegate → work → cross-review → resolve → synthesis", async () => {
    const user = await makeUser(d);
    await connectSandbox(user.id, ["openai", "anthropic", "google", "xai"]);
    const { taskId, runId } = await run(user.id, "Analyze this repository and determine whether it is production ready.");
    await awaitRun(runId);

    const [runRow] = await d.select().from(taskRuns).where(eq(taskRuns.id, runId));
    expect(runRow!.status).toBe("completed");
    expect(runRow!.usage.calls).toBeLessThanOrEqual(DEFAULT_LIMITS.maxCalls);

    const msgs = await d.select().from(messages).where(eq(messages.taskId, taskId)).orderBy(asc(messages.seq));
    const kinds = msgs.map((m) => m.kind);
    expect(kinds[0]).toBe("task");
    expect(kinds).toContain("plan");
    expect(kinds.filter((k) => k === "assignment")).toHaveLength(4);
    expect(kinds.filter((k) => k === "output").length).toBeGreaterThanOrEqual(4);
    expect(kinds).toContain("review");
    expect(kinds).toContain("disagreement");
    expect(kinds).toContain("ruling");
    expect(kinds.at(-1)).toBe("final");

    // Every agent message identifies its provider, model and role.
    for (const m of msgs.filter((x) => x.authorType === "agent")) {
      expect(m.provider).toBeTruthy();
      expect(m.model).toBe("sandbox-simulated");
      expect(m.roleTitle).toBeTruthy();
      expect(m.metadata.simulated).toBe(true);
    }
    // Reviews receive the reviewed output; the final synthesis receives the team's work.
    const review = msgs.find((m) => m.kind === "review")!;
    const reviewed = msgs.find((m) => m.id === review.replyToIds[0])!;
    expect(reviewed.kind).toBe("output");
    expect(reviewed.provider).not.toBe(review.provider);
    expect(msgs.at(-1)!.replyToIds.length).toBeGreaterThanOrEqual(4);

    const [t] = await d.select().from(tasks).where(eq(tasks.id, taskId));
    expect(t!.status).toBe("completed");
  });

  it("never exceeds the call budget and still produces a final answer", async () => {
    const user = await makeUser(d);
    await connectSandbox(user.id, ["openai", "anthropic", "google", "xai"]);
    const limits = { ...DEFAULT_LIMITS, maxCalls: 4 };
    const { taskId, runId } = await run(user.id, "Compare three database options for a startup.", limits);
    await awaitRun(runId);
    const ars = await d.select().from(agentRuns).where(eq(agentRuns.taskRunId, runId));
    expect(ars.length).toBeLessThanOrEqual(4);
    const msgs = await d.select().from(messages).where(eq(messages.taskId, taskId)).orderBy(asc(messages.seq));
    expect(msgs.at(-1)!.kind).toBe("final");
    const [runRow] = await d.select().from(taskRuns).where(eq(taskRuns.id, runId));
    expect(runRow!.stopReason).toMatch(/call limit/);
  });

  it("stops after maxRounds even if the judge keeps asking for more", async () => {
    const user = await makeUser(d);
    await connectSandbox(user.id, ["openai", "anthropic", "google", "xai"]);
    const limits = { ...DEFAULT_LIMITS, maxRounds: 2, maxCalls: 40 };
    const { runId } = await run(user.id, "Is this architecture sound?", limits);
    await awaitRun(runId);
    const [runRow] = await d.select().from(taskRuns).where(eq(taskRuns.id, runId));
    expect(runRow!.round).toBeLessThanOrEqual(2);
    expect(runRow!.status).toBe("completed");
  });

  it("works with a single agent (no cross-review possible)", async () => {
    const user = await makeUser(d);
    await connectSandbox(user.id, ["anthropic"]);
    const { taskId, runId } = await run(user.id, "Explain this bug.");
    await awaitRun(runId);
    const kinds = (await d.select().from(messages).where(eq(messages.taskId, taskId))).map((m) => m.kind);
    expect(kinds).toContain("output");
    expect(kinds).not.toContain("review");
    expect(kinds).toContain("final");
  });

  it("reports providers that are not connected instead of faking them", async () => {
    const user = await makeUser(d);
    await connectSandbox(user.id, ["anthropic", "google"]);
    const { taskId, runId } = await run(user.id, "Review this plan", DEFAULT_LIMITS, ["anthropic", "google", "xai"]);
    await awaitRun(runId);
    const msgs = await d.select().from(messages).where(eq(messages.taskId, taskId));
    expect(msgs.some((m) => m.kind === "status" && m.content.includes("Grok"))).toBe(true);
    expect(msgs.some((m) => m.provider === "xai")).toBe(false);
  });

  it("can be cancelled", async () => {
    sandboxTiming.tokenDelayMs = 20;
    try {
      const user = await makeUser(d);
      await connectSandbox(user.id, ["openai", "anthropic"]);
      const { runId } = await run(user.id, "Write a long report");
      await new Promise((r) => setTimeout(r, 150));
      expect(cancelRun(runId)).toBe(true);
      await awaitRun(runId);
      const [runRow] = await d.select().from(taskRuns).where(eq(taskRuns.id, runId));
      expect(runRow!.status).toBe("cancelled");
    } finally {
      sandboxTiming.tokenDelayMs = 0;
    }
  });

  it("skips Cursor when no repository is attached", async () => {
    const user = await makeUser(d);
    await connectSandbox(user.id, ["anthropic", "cursor"]);
    const roster = await buildRoster(user.id, { task: "fix the bug", maxAgents: 5 });
    expect(roster.map((r) => r.provider)).not.toContain("cursor");
    expect(getAdapter("cursor").capabilities()).not.toContain("chat");
  });
});
