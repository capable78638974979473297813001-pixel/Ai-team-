/**
 * Load check against running servers (sandbox agents): USERS users each start
 * RUNS concurrent 4-agent tasks and stream them to completion, alternating
 * between instances. Reports throughput, latency and any errors.
 *
 *   USERS=10 RUNS=3 tsx scripts/load.ts
 */
export {};

const BASES = (process.env.BASES ?? "http://localhost:3000,http://localhost:3001").split(",");
const USERS = Number(process.env.USERS ?? 10);
const RUNS = Number(process.env.RUNS ?? 3);

type Client = { base: string; cookie: string; csrf: string; ip: string };

async function call(c: Client, method: string, path: string, body?: unknown) {
  const res = await fetch(c.base + path, {
    method,
    // Distinct client IPs (honoured only when the servers run with TRUST_PROXY=true).
    headers: { "content-type": "application/json", origin: c.base, cookie: c.cookie, "x-csrf-token": c.csrf, "x-forwarded-for": c.ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) c.cookie = sc.split(";")[0]!;
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

async function streamToEnd(c: Client, taskId: string) {
  const res = await fetch(`${c.base}/api/tasks/${taskId}/stream`, { headers: { cookie: c.cookie } });
  if (!res.ok) throw new Error(`stream ${res.status}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let deltas = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed early");
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (!ev || !data) continue;
      if (ev === "delta") deltas++;
      const d = JSON.parse(data);
      const status = ev === "run" ? d.run.status : ev === "snapshot" ? d.task.status : null;
      if (status && ["completed", "failed", "cancelled"].includes(status)) {
        await reader.cancel();
        return { status, deltas };
      }
    }
  }
}

async function user(n: number) {
  const c: Client = { base: BASES[n % BASES.length]!, cookie: "", csrf: "", ip: `198.51.100.${n % 250}` };
  const r = await call(c, "POST", "/api/auth/signup", { name: `Load ${n}`, email: `load-${Date.now()}-${n}@example.com`, password: "load test password" });
  if (r.status !== 200) throw new Error(`signup ${r.status} ${JSON.stringify(r.data)}`);
  c.csrf = r.data.csrfToken;
  for (const p of ["openai", "anthropic", "google", "xai"]) await call(c, "POST", `/api/connections/${p}`, { method: "sandbox" });
  return Promise.all(
    Array.from({ length: RUNS }, async (_, k) => {
      const started = Date.now();
      // Stream from the *other* instance to exercise cross-instance fan-out.
      const watcher = { ...c, base: BASES[(n + k + 1) % BASES.length]! };
      const t = await call(c, "POST", "/api/tasks", { prompt: `Load task ${n}.${k}: evaluate this architecture` });
      if (t.status !== 200) return { ok: false, error: `create ${t.status} ${t.data.code}`, ms: 0, deltas: 0 };
      const s = await streamToEnd(watcher, t.data.taskId);
      return { ok: s.status === "completed", error: s.status === "completed" ? undefined : s.status, ms: Date.now() - started, deltas: s.deltas };
    }),
  );
}

async function main() {
  const t0 = Date.now();
  const results = (await Promise.all(Array.from({ length: USERS }, (_, n) => user(n)))).flat();
  const ok = results.filter((r) => r.ok);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))] ?? 0;
  console.log(`runs: ${results.length}  completed: ${ok.length}  failed: ${results.length - ok.length}`);
  console.log(`wall: ${((Date.now() - t0) / 1000).toFixed(1)}s  run latency p50=${(pct(50) / 1000).toFixed(1)}s p95=${(pct(95) / 1000).toFixed(1)}s max=${(pct(100) / 1000).toFixed(1)}s`);
  console.log(`deltas streamed: ${results.reduce((a, r) => a + r.deltas, 0)}`);
  const errors = results.filter((r) => !r.ok).map((r) => r.error);
  if (errors.length) {
    console.log("errors:", errors);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
