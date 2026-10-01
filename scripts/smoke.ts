/**
 * End-to-end smoke test against a running server (default http://localhost:3000).
 * Uses sandbox agents, so it needs ENABLE_SANDBOX_AGENTS=true and no provider keys.
 *
 *   npm run dev            # in one terminal
 *   npm run smoke          # in another
 */
export {};

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
let cookie = "";
let csrf = "";

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as any };
}

function check(cond: unknown, label: string) {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

async function streamUntilDone(taskId: string, timeoutMs = 120_000) {
  const res = await fetch(`${BASE}/api/tasks/${taskId}/stream`, { headers: { cookie } });
  check(res.ok && res.headers.get("content-type")?.includes("text/event-stream"), "SSE stream opened");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const counts: Record<string, number> = {};
  const kinds: string[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (!event || !data) continue;
      counts[event] = (counts[event] ?? 0) + 1;
      const payload = JSON.parse(data);
      if (event === "message") kinds.push(payload.message.kind);
      if (event === "run" && ["completed", "failed", "cancelled"].includes(payload.run.status)) {
        await reader.cancel();
        return { counts, kinds, run: payload.run };
      }
    }
  }
  throw new Error("stream timed out");
}

/** Reads a stream until an agent is mid-response, drops it, reconnects, and rebuilds that agent's text from snapshot + offset deltas. */
async function resumeCheck(taskId: string) {
  const open = () => fetch(`${BASE}/api/tasks/${taskId}/stream`, { headers: { cookie } });
  const events = async function* (res: Response) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (ev && data) yield { ev, data: JSON.parse(data) };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
  let target = "";
  for await (const { ev, data } of events(await open())) {
    if (ev === "delta" && data.offset > 50) {
      target = data.agentRunId;
      break;
    }
  }
  let text = "";
  for await (const { ev, data } of events(await open())) {
    if (ev === "snapshot") text = data.agentRuns.find((a: any) => a.id === target)?.partialOutput ?? "";
    if (ev === "delta" && data.agentRunId === target) text = text.slice(0, data.offset) + data.text;
    if (ev === "agent" && data.agentRun.id === target && data.agentRun.status !== "running") break;
  }
  // Wait for the run to finish, then compare with the stored output.
  for await (const { ev, data } of events(await open())) {
    const done = (s: string) => ["completed", "failed", "cancelled"].includes(s);
    if ((ev === "snapshot" && done(data.task.status)) || (ev === "run" && done(data.run.status))) break;
  }
  const view = await call("GET", `/api/tasks/${taskId}`);
  const final = view.data.messages.find((m: any) => m.agentRunId === target)?.content ?? "";
  return { ok: text.length > 0 && text === final, chars: text.length, agentRunId: target };
}

async function main() {
  const email = `smoke-${Date.now()}@example.com`;

  let r = await call("POST", "/api/auth/signup", { name: "Smoke", email, password: "correct horse battery" });
  check(r.status === 200 && r.data.csrfToken && cookie, "sign up returns session cookie + CSRF token");
  csrf = r.data.csrfToken;

  // --- security checks
  r = await call("POST", "/api/teams", { name: "x", agents: [] }, { "x-csrf-token": "wrong" });
  check(r.status === 403, "request with a bad CSRF token is refused");
  r = await call("POST", "/api/teams", { name: "x", agents: [] }, { origin: "https://evil.example" });
  check(r.status === 403, "cross-origin request is refused");
  r = await call("POST", "/api/connections/anthropic", { method: "oauth" });
  check(r.status === 400 && /does not permit/.test(r.data.error), "Claude subscription OAuth is refused as unsupported");
  r = await call("POST", "/api/connections/xai", { method: "oauth" });
  check(r.status === 400, "Grok subscription OAuth is refused as coming soon");

  // --- connections
  r = await call("GET", "/api/connections");
  const states = Object.fromEntries(r.data.connections.map((c: any) => [c.provider, c.state]));
  check(Object.values(states).every((s) => s === "not_connected"), "all providers start not connected");
  check(JSON.stringify(r.data).match(/accessToken|access_token_enc|refreshToken/) === null, "connection list exposes no tokens");
  for (const p of ["openai", "anthropic", "google", "xai"]) {
    r = await call("POST", `/api/connections/${p}`, { method: "sandbox" });
    check(r.status === 200 && r.data.connection.state === "connected", `connected ${p} (sandbox)`);
  }

  // --- team
  r = await call("POST", "/api/teams", {
    name: "Software Team",
    agents: [
      { provider: "anthropic", roleTitle: "Lead Developer", roleInstructions: "Inspect the code deeply." },
      { provider: "openai", roleTitle: "Architect", roleInstructions: "Evaluate structure; write the final answer.", isLead: true },
      { provider: "google", roleTitle: "Reviewer", roleInstructions: "Critique and judge disagreements." },
      { provider: "xai", roleTitle: "Researcher", roleInstructions: "Check current best practice." },
    ],
  });
  check(r.status === 200 && r.data.id, "created a team");
  const teamId = r.data.id;

  // --- task
  r = await call("POST", "/api/tasks", { prompt: "Analyze this repository and determine whether it is production ready.", teamId });
  check(r.status === 200 && r.data.taskId, "started a task");
  const taskId = r.data.taskId;
  const s = await streamUntilDone(taskId);
  check(s.run.status === "completed", `run completed (${s.run.usage.calls} calls)`);
  check((s.counts.delta ?? 0) > 0, `received ${s.counts.delta} streamed deltas`);
  for (const k of ["plan", "assignment", "output", "review", "final"]) check(s.kinds.includes(k), `thread contains a "${k}" message`);

  r = await call("GET", `/api/tasks/${taskId}`);
  const final = r.data.messages.at(-1);
  check(final.kind === "final" && final.provider && final.roleTitle, `final answer by ${final.provider} (${final.roleTitle})`);
  check(r.data.agentRuns.every((a: any) => a.status !== "running"), "no agent runs left running");

  // --- follow-up in the same conversation
  r = await call("POST", `/api/tasks/${taskId}/runs`, { prompt: "What should we fix first?" });
  check(r.status === 200, "follow-up started");
  const s2 = await streamUntilDone(taskId);
  check(s2.run.status === "completed", "follow-up completed");

  // --- cancel
  r = await call("POST", "/api/tasks", { prompt: "Write a very long report on distributed systems.", providers: ["openai", "anthropic"] });
  const cancelId = r.data.taskId;
  await new Promise((res) => setTimeout(res, 300));
  r = await call("POST", `/api/tasks/${cancelId}/cancel`);
  check(r.status === 200, "cancel accepted");

  // --- import
  r = await call("POST", "/api/imports", { source: "text", text: "User: How do I scale Postgres?\nAssistant: Start with read replicas." });
  check(r.status === 200 && r.data.ids.length === 1, "imported a pasted conversation");

  // --- resumable streaming: disconnect mid-answer, reconnect, rebuild the exact text
  r = await call("POST", "/api/tasks", { prompt: "Summarise the trade-offs of microservices.", providers: ["anthropic", "openai"] });
  const resumeId = r.data.taskId;
  const resumed = await resumeCheck(resumeId);
  check(resumed.ok, `reconnect mid-stream rebuilt ${resumed.chars} chars exactly (agent run ${resumed.agentRunId.slice(0, 8)})`);

  // --- API tokens, idempotency, pagination, drafting, sessions, audit
  r = await call("POST", "/api/tokens", { name: "smoke", scopes: ["read", "write"], expiresInDays: 1 });
  check(r.status === 200 && /^ait_/.test(r.data.token), "created a personal access token");
  const pat = r.data.token;
  r = await call("POST", "/api/tokens", { name: "ro", scopes: ["read"], expiresInDays: 1 });
  const readOnly = r.data.token;
  const bearer = async (token: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, data: (await res.json().catch(() => ({}))) as any };
  };
  let b = await bearer(pat, "GET", "/api/connections");
  check(b.status === 200 && b.headers.get("x-request-id"), "bearer token reads without cookie, CSRF or Origin");
  b = await bearer(readOnly, "POST", "/api/teams", { name: "x", agents: [{ provider: "openai", roleTitle: "r" }] });
  check(b.status === 403, "read-only token cannot write");
  b = await bearer(pat, "POST", "/api/tokens", { name: "escalate" });
  check(b.status === 403, "tokens cannot mint tokens (session-only)");
  const idem = { "idempotency-key": `smoke-${Date.now()}` };
  const first = await bearer(pat, "POST", "/api/tasks", { prompt: "Idempotent task", providers: ["openai"] }, idem);
  const replay = await bearer(pat, "POST", "/api/tasks", { prompt: "Idempotent task", providers: ["openai"] }, idem);
  check(first.status === 200 && replay.data.taskId === first.data.taskId && replay.headers.get("idempotent-replayed") === "true", "Idempotency-Key replays instead of starting a second run");
  const mismatch = await bearer(pat, "POST", "/api/tasks", { prompt: "Different body", providers: ["openai"] }, idem);
  check(mismatch.status === 422, "reusing a key with a different body is rejected");
  r = await call("GET", "/api/tasks?limit=2");
  check(r.data.tasks.length === 2 && r.data.nextCursor, "tasks are paginated");
  r = await call("GET", `/api/tasks?limit=2&cursor=${r.data.nextCursor}`);
  check(r.data.tasks.length >= 1, "next page loads with the cursor");
  r = await call("POST", "/api/teams/draft", { description: "A team to audit our checkout API for security bugs" });
  check(r.status === 200 && r.data.team.agents.length >= 2, `drafted a team from a description (${r.data.draftedBy ?? "heuristic"})`);
  r = await call("GET", "/api/auth/sessions");
  check(r.data.sessions.some((x: any) => x.current), "sessions list marks the current session");
  r = await call("GET", "/api/audit");
  check(["auth.signup", "connection.connect", "task.create", "token.create"].every((a) => r.data.events.some((e: any) => e.action === a)), "audit log records security events");
  r = await call("GET", "/api/openapi.json");
  check(r.data.openapi === "3.1.0", "OpenAPI document is served");

  // --- ownership: another user can't read this task
  const mine = { cookie, csrf };
  cookie = "";
  csrf = "";
  r = await call("POST", "/api/auth/signup", { name: "Other", email: `other-${Date.now()}@example.com`, password: "another long password" });
  csrf = r.data.csrfToken;
  r = await call("GET", `/api/tasks/${taskId}`);
  check(r.status === 404, "another user cannot read the task");
  ({ cookie, csrf } = mine);

  r = await call("POST", "/api/auth/logout");
  check(r.status === 200, "signed out");
  r = await call("GET", "/api/connections");
  check(r.status === 401, "session is invalid after sign out");
  console.log("\nSmoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
