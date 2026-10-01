/**
 * Verifies cross-instance behaviour with two running servers that share one
 * database and EVENT_BUS=postgres: a run executing on instance A streams to an
 * SSE client on instance B, and a cancel sent to B stops the run on A.
 *
 *   A_URL=http://localhost:3000 B_URL=http://localhost:3001 tsx scripts/multi-instance.ts
 */
export {};

const A = process.env.A_URL ?? "http://localhost:3000";
const B = process.env.B_URL ?? "http://localhost:3001";
let cookie = "";
let csrf = "";

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0]!;
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

function check(cond: unknown, label: string) {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

async function stream(base: string, taskId: string, onEvent: (event: string, data: any) => boolean) {
  const res = await fetch(`${base}/api/tasks/${taskId}/stream`, { headers: { cookie } });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
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
      if (ev && data && onEvent(ev, JSON.parse(data))) {
        await reader.cancel();
        return;
      }
    }
  }
}

async function main() {
  let r = await call(A, "POST", "/api/auth/signup", { name: "Multi", email: `multi-${Date.now()}@example.com`, password: "long enough password" });
  csrf = r.data.csrfToken;
  check(r.status === 200, "signed up on A");
  for (const p of ["openai", "anthropic", "google"]) await call(A, "POST", `/api/connections/${p}`, { method: "sandbox" });
  r = await call(B, "GET", "/api/connections");
  check(r.data.connections.filter((c: any) => c.state === "connected").length === 3, "B sees the connections made on A");

  // Start on A, watch on B.
  r = await call(A, "POST", "/api/tasks", { prompt: "Assess this architecture." });
  const taskId = r.data.taskId;
  let deltas = 0;
  let finalSeen = false;
  let status = "";
  await stream(B, taskId, (ev, data) => {
    if (ev === "delta") deltas++;
    if (ev === "message" && data.message.kind === "final") finalSeen = true;
    if (ev === "run" && ["completed", "failed", "cancelled"].includes(data.run.status)) {
      status = data.run.status;
      return true;
    }
    return false;
  });
  check(deltas > 0, `B streamed ${deltas} live deltas from a run executing on A`);
  check(finalSeen && status === "completed", "B received the final answer and completion");

  // Watch on A, drop the stream mid-answer, resume on B (snapshot from the DB + offset deltas via NOTIFY).
  r = await call(A, "POST", "/api/tasks", { prompt: "Explain eventual consistency.", providers: ["anthropic", "openai"] });
  const t3 = r.data.taskId;
  let target = "";
  await stream(A, t3, (ev, data) => {
    if (ev === "delta" && data.offset > 40) {
      target = data.agentRunId;
      return true;
    }
    return false;
  });
  let text = "";
  await stream(B, t3, (ev, data) => {
    if (ev === "snapshot") text = data.agentRuns.find((a: any) => a.id === target)?.partialOutput ?? "";
    if (ev === "delta" && data.agentRunId === target) text = text.slice(0, data.offset) + data.text;
    return ev === "agent" && data.agentRun.id === target && data.agentRun.status !== "running";
  });
  await stream(B, t3, (ev, data) => (ev === "snapshot" && data.task.status !== "running") || (ev === "run" && data.run.status !== "running"));
  r = await call(B, "GET", `/api/tasks/${t3}`);
  const stored = r.data.messages.find((m: any) => m.agentRunId === target)?.content;
  check(text.length > 0 && text === stored, `resumed on B mid-answer and rebuilt ${text.length} chars exactly`);

  // Start on A, cancel via B.
  r = await call(A, "POST", "/api/tasks", { prompt: "Write an exhaustive report." });
  const t2 = r.data.taskId;
  await new Promise((res) => setTimeout(res, 400));
  r = await call(B, "POST", `/api/tasks/${t2}/cancel`);
  check(r.status === 200 && r.data.cancelled === 1, "B accepted a cancel for a run owned by A");
  let s2 = "";
  await stream(A, t2, (ev, data) => {
    if (ev === "snapshot" && ["cancelled", "completed", "failed"].includes(data.runs.at(-1)?.status)) {
      s2 = data.runs.at(-1).status;
      return true;
    }
    if (ev === "run" && ["completed", "failed", "cancelled"].includes(data.run.status)) {
      s2 = data.run.status;
      return true;
    }
    return false;
  });
  check(s2 === "cancelled", "the run on A was cancelled");
  console.log("\nMulti-instance check passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
