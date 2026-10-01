import { timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { renderMetrics } from "@/server/metrics";
import { activeRunCount } from "@/server/orchestrator/runner";

export const dynamic = "force-dynamic";

/** Prometheus metrics for this instance. Disabled unless METRICS_TOKEN is set. */
export function GET(req: Request) {
  const expected = env().METRICS_TOKEN;
  if (!expected) return new Response("Not found", { status: 404 });
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response("Unauthorized", { status: 401 });
  const body = renderMetrics({
    aiteam_active_runs: { help: "Orchestration runs executing on this instance", value: activeRunCount() },
    aiteam_process_resident_memory_bytes: { help: "Resident memory", value: process.memoryUsage().rss },
  });
  return new Response(body, { headers: { "content-type": "text/plain; version=0.0.4" } });
}
