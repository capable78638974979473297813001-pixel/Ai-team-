import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { taskRuns, webhooks } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { DEFAULT_LIMITS } from "@/server/orchestrator/budget";
import { awaitRun, RunCapacityError, startRun } from "@/server/orchestrator/runner";
import { runtimeAdapter } from "@/server/providers/registry";
import { sandboxTiming } from "@/server/providers/sandbox";
import { isPublicAddress, resolveSafeUrl } from "@/server/security/ssrf";
import { saveConnection } from "@/server/services/connections";
import { exportAccount } from "@/server/services/export";
import { createTask } from "@/server/services/tasks";
import { buildRoster } from "@/server/services/teams";
import { createWebhook, emitWebhook, signPayload, testWebhook, webhookTiming } from "@/server/services/webhooks";
import { createApiToken } from "@/server/auth/tokens";
import { freshDb, makeUser } from "./helpers";

let d: Db;

describe("SSRF guard", () => {
  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(a), a).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  it("rejects non-https, credentials, odd ports and private targets", async () => {
    await expect(resolveSafeUrl("http://example.com/hook")).rejects.toThrow(/https/);
    await expect(resolveSafeUrl("https://user:pw@example.com/")).rejects.toThrow(/credentials/);
    await expect(resolveSafeUrl("https://8.8.8.8:22/")).rejects.toThrow(/port/);
    await expect(resolveSafeUrl("https://127.0.0.1/")).rejects.toThrow(/public/);
    await expect(resolveSafeUrl("https://[::1]/")).rejects.toThrow(/public/);
    await expect(resolveSafeUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/public/);
    await expect(resolveSafeUrl("https://localhost/")).rejects.toThrow(/public/);
    expect((await resolveSafeUrl("https://8.8.8.8/hook")).address).toBe("8.8.8.8");
  });
});

describe("webhooks", () => {
  let server: Server;
  let base = "";
  const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
  let nextStatus: number[] = [];

  beforeAll(async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    resetEnvCache();
    webhookTiming.retryDelaysMs = [10, 10, 10];
    sandboxTiming.tokenDelayMs = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(nextStatus.shift() ?? 200);
        res.end("ok");
      });
    });
    // Listen dual-stack and use a hostname, so delivery exercises the pinned DNS lookup path.
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.WEBHOOKS_ALLOW_PRIVATE;
    resetEnvCache();
    await new Promise((r) => server.close(r));
  });
  beforeEach(async () => {
    d = await freshDb();
    received.length = 0;
    nextStatus = [];
  });

  const waitFor = async (cond: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };

  it("signs deliveries so receivers can verify them", async () => {
    const u = await makeUser(d);
    const { secret, webhook } = await createWebhook(u.id, `${base}/hook`, ["run.finished"]);
    expect(secret).toMatch(/^whsec_/);
    const [row] = await d.select().from(webhooks);
    expect(row!.secretEnc).not.toContain(secret);
    const result = await testWebhook(u.id, webhook.id);
    expect(result).toMatchObject({ ok: true, status: 200 });
    const { headers, body } = received[0]!;
    const [, t, v1] = String(headers["x-aiteam-signature"]).match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    expect(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")).toBe(v1);
    expect(headers["x-aiteam-event"]).toBe("run.finished");
    expect(JSON.parse(body)).toMatchObject({ type: "run.finished", data: { test: true } });
    expect(signPayload("s", "b", 1)).toBe(`t=1,v1=${createHmac("sha256", "s").update("1.b").digest("hex")}`);
  });

  it("retries 5xx, does not retry other 4xx, and records the outcome", async () => {
    const u = await makeUser(d);
    const { webhook } = await createWebhook(u.id, `${base}/hook`, ["run.finished"]);
    nextStatus = [503, 502, 200];
    emitWebhook(u.id, "run.finished", { x: 1 });
    await waitFor(() => received.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(3);
    let [row] = await d.select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(row!.lastStatus).toBe("ok 200");
    expect(row!.consecutiveFailures).toBe(0);

    received.length = 0;
    nextStatus = [410];
    emitWebhook(u.id, "run.finished", { x: 2 });
    await waitFor(() => received.length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(1);
    [row] = await d.select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(row!.consecutiveFailures).toBe(1);
  });

  it("disables a webhook after repeated failures", async () => {
    const u = await makeUser(d);
    const { webhook } = await createWebhook(u.id, `${base}/hook`, ["run.finished"]);
    await d.update(webhooks).set({ consecutiveFailures: 19 }).where(eq(webhooks.id, webhook.id));
    nextStatus = [400];
    await testWebhook(u.id, webhook.id);
    const [row] = await d.select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(row!.disabled).toBe(true);
  });

  it("is notified with the final answer when a run finishes", async () => {
    const u = await makeUser(d);
    const out = await runtimeAdapter("anthropic", "sandbox").connect({ method: "sandbox" });
    if (out.kind === "connected") await saveConnection(u.id, "anthropic", out.credentials, out.account);
    await createWebhook(u.id, `${base}/hook`, ["run.finished"]);
    const task = await createTask(u.id, "hi", null);
    const roster = await buildRoster(u.id, { task: "hi", maxAgents: 5 });
    const runId = await startRun({ userId: u.id, taskId: task.id, prompt: "hi", roster, limits: DEFAULT_LIMITS, options: {} });
    await awaitRun(runId);
    await waitFor(() => received.length === 1);
    const payload = JSON.parse(received[0]!.body);
    expect(payload.data).toMatchObject({ taskId: task.id, runId, status: "completed", finalAnswer: { provider: "anthropic" } });
    expect(payload.data.finalAnswer.content.length).toBeGreaterThan(10);
  });
});

describe("per-user concurrency", () => {
  beforeEach(async () => {
    d = await freshDb();
  });

  it("refuses runs beyond MAX_CONCURRENT_RUNS, even when started in parallel", async () => {
    const u = await makeUser(d);
    const roster = [{ key: "claude", provider: "anthropic", model: null, roleTitle: "Dev", roleInstructions: "", isLead: true }];
    // Occupy two slots with runs that look active.
    for (let i = 0; i < 2; i++) {
      const t = await createTask(u.id, `busy ${i}`, null);
      await d.insert(taskRuns).values({ taskId: t.id, prompt: "x", status: "running", limits: DEFAULT_LIMITS, heartbeatAt: new Date() });
    }
    const t = await createTask(u.id, "x", null);
    const attempts = await Promise.allSettled(
      [1, 2, 3].map(() => startRun({ userId: u.id, taskId: t.id, prompt: "x", roster, limits: DEFAULT_LIMITS, options: {} })),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected" && a.reason instanceof RunCapacityError)).toHaveLength(2);
    for (const a of attempts) if (a.status === "fulfilled") await awaitRun(a.value);
  });
});

describe("data export", () => {
  beforeEach(async () => {
    d = await freshDb();
  });

  it("includes the user's data and never credentials", async () => {
    const u = await makeUser(d);
    await saveConnection(u.id, "openai", { method: "api_key", accessToken: "sk-export-secret-123", scopes: [], extra: {} }, { label: "API key", info: {}, models: [], defaultModel: null });
    const { token } = await createApiToken(u.id, "t", ["read"], null);
    await createTask(u.id, "my conversation", null);
    const data = await exportAccount(u.id);
    const text = JSON.stringify(data);
    expect(data.conversations).toHaveLength(1);
    expect(data.connections[0]).toMatchObject({ provider: "openai", method: "api_key" });
    expect(text).not.toContain("sk-export-secret-123");
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/accessTokenEnc|tokenHash|secretEnc|passwordHash/);
  });
});
