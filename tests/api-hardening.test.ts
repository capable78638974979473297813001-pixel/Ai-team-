import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "@/server/auth/guard";
import { createApiToken, lookupApiToken, revokeApiToken } from "@/server/auth/tokens";
import type { Db } from "@/server/db/client";
import { agentRuns, apiTokens, providerConnections } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { renderMetrics } from "@/server/metrics";
import { retryDelay } from "@/server/orchestrator/engine";
import { bus, type RunEvent } from "@/server/orchestrator/events";
import { DEFAULT_LIMITS } from "@/server/orchestrator/budget";
import { awaitRun, startRun } from "@/server/orchestrator/runner";
import { setFetch } from "@/server/providers/http";
import { agentHostId, OpenAIProvider } from "@/server/providers/openai";
import { runtimeAdapter } from "@/server/providers/registry";
import { sandboxTiming } from "@/server/providers/sandbox";
import { parseRetryAfter, ProviderError } from "@/server/providers/types";
import { toProviderError } from "@/server/providers/http";
import { currentKeyVersion, decrypt, envelopeKeyVersion, resetKeyring } from "@/server/security/crypto";
import { resetRateLimits } from "@/server/security/rate-limit";
import { rotateEncryptionKeys } from "@/server/security/rotate";
import { checkHealth, saveConnection } from "@/server/services/connections";
import { idempotent } from "@/server/services/idempotency";
import { createTask, getTaskView, listTasksPage } from "@/server/services/tasks";
import { draftTeam } from "@/server/services/team-draft";
import { buildRoster } from "@/server/services/teams";
import { freshDb, jsonResponse, makeUser, mockFetch } from "./helpers";
import { randomBytes } from "node:crypto";

let d: Db;
beforeAll(() => {
  sandboxTiming.tokenDelayMs = 0;
});
beforeEach(async () => {
  d = await freshDb();
  resetRateLimits();
});

async function connectSandbox(userId: string, providers: ("openai" | "anthropic" | "google" | "xai")[]) {
  for (const p of providers) {
    const out = await runtimeAdapter(p, "sandbox").connect({ method: "sandbox" });
    if (out.kind === "connected") await saveConnection(userId, p, out.credentials, out.account);
  }
}

describe("personal access tokens", () => {
  it("stores only a hash and resolves the plaintext once", async () => {
    const u = await makeUser(d);
    const { token, record } = await createApiToken(u.id, "ci", ["read", "write"], 30);
    expect(token).toMatch(/^ait_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    const [row] = await d.select().from(apiTokens);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.prefix).toBe(token.slice(0, 12));
    const s = await lookupApiToken(token);
    expect(s).toMatchObject({ kind: "token", scopes: ["read", "write"], user: { id: u.id } });
    expect(await lookupApiToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await revokeApiToken(u.id, record.id)).toBe(true);
    expect(await lookupApiToken(token)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const u = await makeUser(d);
    const { token } = await createApiToken(u.id, "old", ["read"], 1);
    await d.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await lookupApiToken(token)).toBeNull();
  });

  it("guard: bearer requests skip CSRF/Origin, enforce scopes and session-only routes, and carry a request id", async () => {
    const u = await makeUser(d);
    const rw = (await createApiToken(u.id, "rw", ["read", "write"], null)).token;
    const ro = (await createApiToken(u.id, "ro", ["read"], null)).token;
    const handler = api({ auth: true }, async ({ session }) => ({ user: session.user.id, kind: session.kind }));
    const sensitive = api({ auth: true, sessionOnly: true }, async () => ({ ok: true }));
    const call = (h: typeof handler, token: string, method = "POST", headers: Record<string, string> = {}) =>
      h(new Request("http://localhost:3000/api/x", { method, headers: { authorization: `Bearer ${token}`, ...headers } }), { params: Promise.resolve({}) });

    const ok = await call(handler, rw);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ user: u.id, kind: "token" });
    expect(ok.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    expect((await call(handler, ro)).status).toBe(403);
    expect((await call(handler, ro, "GET")).status).toBe(200);
    expect((await call(sensitive, rw)).status).toBe(403);

    const bad = await call(handler, "ait_nope");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("invalid_token");

    const echoed = await call(handler, rw, "GET", { "x-request-id": "client-req-12345" });
    expect(echoed.headers.get("x-request-id")).toBe("client-req-12345");
  });
});

describe("idempotency keys", () => {
  const req = (key?: string) => new Request("http://x/api/tasks", { method: "POST", headers: key ? { "idempotency-key": key } : {} });

  it("replays the stored response for a retried request instead of running twice", async () => {
    const u = await makeUser(d);
    let runs = 0;
    const work = async () => ({ taskId: `t${++runs}` });
    const first = await idempotent(req("key-00000001"), u.id, "POST /api/tasks", '{"a":1}', work);
    const again = await idempotent(req("key-00000001"), u.id, "POST /api/tasks", '{"a":1}', work);
    expect(await first.json()).toEqual({ taskId: "t1" });
    expect(await again.json()).toEqual({ taskId: "t1" });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(runs).toBe(1);
  });

  it("rejects reuse with a different body, and frees the key when the request fails", async () => {
    const u = await makeUser(d);
    await idempotent(req("key-00000002"), u.id, "r", '{"a":1}', async () => ({ ok: 1 }));
    await expect(idempotent(req("key-00000002"), u.id, "r", '{"a":2}', async () => ({ ok: 2 }))).rejects.toMatchObject({ status: 422 });
    await expect(idempotent(req("key-00000003"), u.id, "r", "{}", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const retry = await idempotent(req("key-00000003"), u.id, "r", "{}", async () => ({ ok: 3 }));
    expect(await retry.json()).toEqual({ ok: 3 });
  });

  it("scopes keys per user", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await idempotent(req("shared-key-1"), a.id, "r", "{}", async () => ({ who: "a" }));
    expect(await (await idempotent(req("shared-key-1"), b.id, "r", "{}", async () => ({ who: "b" }))).json()).toEqual({ who: "b" });
  });
});

describe("pagination", () => {
  it("walks every task exactly once with keyset cursors", async () => {
    const u = await makeUser(d);
    for (let i = 0; i < 7; i++) await createTask(u.id, `task ${i}`, null);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listTasksPage>> = await listTasksPage(u.id, { limit: 3, cursor });
      seen.push(...page.tasks.map((t) => t.title));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect((await listTasksPage(u.id, { limit: 3, cursor: "garbage" })).tasks).toHaveLength(3);
  });

  it("is exact with identical and microsecond-apart timestamps", async () => {
    const u = await makeUser(d);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await createTask(u.id, `t${i}`, null)).id);
    // Three share one instant; three differ only in microseconds; three are ordinary.
    await d.execute(sql`update tasks set updated_at = '2026-01-01 00:00:00.000001+00' where id in (${sql.join(ids.slice(0, 3).map((i) => sql`${i}::uuid`), sql`, `)})`);
    await d.execute(sql`update tasks set updated_at = '2026-01-01 00:00:00.000002+00' where id = ${ids[3]!}::uuid`);
    await d.execute(sql`update tasks set updated_at = '2026-01-01 00:00:00.000003+00' where id = ${ids[4]!}::uuid`);
    await d.execute(sql`update tasks set updated_at = '2026-01-01 00:00:00.000004+00' where id = ${ids[5]!}::uuid`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listTasksPage>> = await listTasksPage(u.id, { limit: 2, cursor });
      seen.push(...page.tasks.map((t) => t.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(9);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});

describe("retries", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 5_000)).toBe(5000);
    expect(parseRetryAfter("soon")).toBeNull();
  });
  it("uses Retry-After when present (capped) and jittered exponential backoff otherwise", () => {
    expect(retryDelay(1, 4_000)).toBe(4_000);
    expect(retryDelay(1, 600_000)).toBe(20_000);
    expect(retryDelay(1, null, 1000, () => 0)).toBe(500);
    expect(retryDelay(3, null, 1000, () => 1)).toBe(4000);
  });
  it("maps 429 responses to retryable errors with the server's wait", async () => {
    const err = await toProviderError("X", new Response("{}", { status: 429, headers: { "retry-after": "7" } }));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true, retryAfterMs: 7000 });
    expect((await toProviderError("X", new Response("{}", { status: 400 }))).retryable).toBe(false);
  });
});

describe("resumable streaming", () => {
  it("publishes contiguous delta offsets and exposes partial output while an agent is mid-response", async () => {
    sandboxTiming.tokenDelayMs = 15;
    try {
      const u = await makeUser(d);
      await connectSandbox(u.id, ["anthropic"]);
      const task = await createTask(u.id, "explain", null);
      const offsets = new Map<string, number>();
      let contiguous = true;
      let partialSeen = false;
      const off = bus.subscribe(task.id, (e: RunEvent) => {
        if (e.type !== "delta") return;
        if ((offsets.get(e.agentRunId) ?? 0) !== e.offset) contiguous = false;
        offsets.set(e.agentRunId, e.offset + e.text.length);
      });
      const roster = await buildRoster(u.id, { task: "explain", maxAgents: 5 });
      const runId = await startRun({ userId: u.id, taskId: task.id, prompt: "explain", roster, limits: DEFAULT_LIMITS, options: {} });
      for (let i = 0; i < 40 && !partialSeen; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const view = await getTaskView(u.id, task.id);
        const running = view!.agentRuns.find((a) => a.status === "running" && a.partialOutput);
        if (running) partialSeen = running.partialOutput!.length > 0;
      }
      await awaitRun(runId);
      off();
      expect(contiguous).toBe(true);
      expect(partialSeen).toBe(true);
      const done = await getTaskView(u.id, task.id);
      expect(done!.agentRuns.every((a) => a.partialOutput === null)).toBe(true);
      const [work] = await d.select().from(agentRuns).where(eq(agentRuns.kind, "work"));
      expect(offsets.get(work!.id)).toBe(work!.output!.length);
    } finally {
      sandboxTiming.tokenDelayMs = 0;
    }
  });
});

describe("team drafting", () => {
  it("drafts with a connected model and only uses allowed providers", async () => {
    const u = await makeUser(d);
    await connectSandbox(u.id, ["openai", "anthropic", "google"]);
    const { team, draftedBy } = await draftTeam(u.id, "Audit our payment service for security issues");
    expect(draftedBy).toBe("openai");
    expect(team.agents.length).toBeGreaterThanOrEqual(2);
    expect(team.agents.every((a) => ["openai", "anthropic", "google"].includes(a.provider))).toBe(true);
    expect(team.agents.filter((a) => a.isLead)).toHaveLength(1);
  });

  it("falls back to a deterministic draft without connections", async () => {
    const u = await makeUser(d);
    const { team, draftedBy } = await draftTeam(u.id, "Research the latest trends in battery chemistry");
    expect(draftedBy).toBeNull();
    expect(team.agents[0]!.provider).toBe("openai");
    expect(team.agents.some((a) => a.provider === "cursor")).toBe(false);
  });
});

describe("operations", () => {
  it("rotates stored credentials onto the newest encryption key", async () => {
    const u = await makeUser(d);
    const old = process.env.ENCRYPTION_KEYS!;
    const v1 = old.split(",")[1]!;
    process.env.ENCRYPTION_KEYS = v1;
    resetEnvCache();
    resetKeyring();
    await saveConnection(u.id, "anthropic", { method: "api_key", accessToken: "sk-ant-rotate-me", scopes: [], extra: {} }, { label: null, info: {}, models: [], defaultModel: null });
    process.env.ENCRYPTION_KEYS = `v9:${randomBytes(32).toString("base64")},${v1}`;
    resetEnvCache();
    resetKeyring();
    expect(currentKeyVersion()).toBe("v9");
    expect((await rotateEncryptionKeys({ dryRun: true })).rotated).toBe(1);
    expect(await rotateEncryptionKeys()).toMatchObject({ rotated: 1, failed: 0 });
    expect((await rotateEncryptionKeys()).rotated).toBe(0);
    const [row] = await d.select().from(providerConnections);
    expect(envelopeKeyVersion(row!.accessTokenEnc!)).toBe("v9");
    expect(decrypt(row!.accessTokenEnc!, `${u.id}:anthropic:access`)).toBe("sk-ant-rotate-me");
    process.env.ENCRYPTION_KEYS = old;
    resetEnvCache();
    resetKeyring();
  });

  it("health checks refresh the model list and keep the default valid", async () => {
    const u = await makeUser(d);
    await saveConnection(u.id, "openai", { method: "api_key", accessToken: "sk-x", scopes: [], extra: {} }, { label: null, info: {}, models: ["gpt-5"], defaultModel: "gpt-5" });
    setFetch(mockFetch({ "GET https://api.openai.com/v1/models": () => jsonResponse({ data: [{ id: "gpt-6.1" }, { id: "gpt-6.1-mini" }] }) }).impl);
    const r = await checkHealth(u.id, "openai");
    expect(r).toMatchObject({ ok: true, defaultModel: "gpt-6.1" });
    const [row] = await d.select().from(providerConnections);
    expect(row!.models).toEqual(["gpt-6.1", "gpt-6.1-mini"]);
    setFetch((...a) => fetch(...a));
  });

  it("derives a stable UUID host id for Sign in with ChatGPT and sends it with PKCE", async () => {
    process.env.OPENAI_SIWC_CLIENT_ID = "dynamic_agent_client";
    resetEnvCache();
    try {
      expect(agentHostId()).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(agentHostId()).toBe(agentHostId());
      const out = await new OpenAIProvider().connect({ method: "oauth", redirectUri: "http://localhost:3000/api/oauth/openai/callback", state: "s", nonce: "n", codeChallenge: "c", fields: {} });
      if (out.kind !== "redirect") throw new Error("expected redirect");
      const q = new URL(out.url).searchParams;
      expect(q.get("ext_agent_host_id")).toBe(agentHostId());
      expect(q.get("code_challenge_method")).toBe("S256");
      expect(q.get("resource")).toBe("https://api.openai.com/v1");
      expect(q.get("scope")).toContain("offline_access");
    } finally {
      delete process.env.OPENAI_SIWC_CLIENT_ID;
      resetEnvCache();
    }
  });

  it("renders Prometheus metrics", async () => {
    const { metrics } = await import("@/server/metrics");
    metrics.providerCalls.inc({ provider: "openai", kind: "work", outcome: "ok" });
    const text = renderMetrics({ aiteam_active_runs: { help: "x", value: 2 } });
    expect(text).toMatch(/aiteam_provider_calls_total\{.*provider="openai".*\} \d+/);
    expect(text).toContain("aiteam_active_runs 2");
  });
});
