import { eq } from "drizzle-orm";
import { api, ApiError } from "@/server/auth/guard";
import { db } from "@/server/db/client";
import { agentRuns } from "@/server/db/schema";
import { bus, type RunEvent } from "@/server/orchestrator/events";
import { livePartials } from "@/server/orchestrator/views";
import { getOwnedTask, getTaskView } from "@/server/services/tasks";

export const dynamic = "force-dynamic";

const GAP_WAIT_MS = 3_000;
const GAP_POLL_MS = 150;

/**
 * Text [from, to) of an agent run's stream that this connection missed. On the
 * owning instance it comes from memory; on other instances from the partial
 * output the owner flushes to the database (every ~750ms), so we wait briefly
 * for the flush to cover the gap.
 */
async function fetchGap(agentRunId: string, from: number, to: number): Promise<string | null> {
  const deadline = Date.now() + GAP_WAIT_MS;
  while (true) {
    const local = livePartials.get(agentRunId);
    if (local && local.length >= to) return local.slice(from, to);
    const [row] = await db().select({ output: agentRuns.output }).from(agentRuns).where(eq(agentRuns.id, agentRunId));
    if (row?.output && row.output.length >= to) return row.output.slice(from, to);
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, GAP_POLL_MS));
  }
}

/**
 * Server-Sent Events: one `snapshot` with the durable state (including partial
 * text of agents mid-response), then live `run` / `message` / `agent` /
 * `delta` / `tool` events, in order.
 *
 * Guarantee: for every running agent, the client's text (snapshot partial plus
 * deltas applied as `text.slice(0, offset) + delta.text`) is gap-free. Events
 * published while the snapshot is built are queued; if a delta arrives ahead of
 * what this client has (possible when resuming on a different instance), the
 * missing slice is fetched and sent first.
 */
export const GET = api<true, { id: string }>({ auth: true }, async ({ req, session }, { id }) => {
  if (!(await getOwnedTask(session.user.id, id))) throw new ApiError(404, "Conversation not found");

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      /** Characters this client holds per running agent run. */
      const known = new Map<string, number>();
      let ready = false;
      const pending: RunEvent[] = [];
      let chain = Promise.resolve();

      const handle = async (e: RunEvent) => {
        if (e.type === "delta") {
          let have = known.get(e.agentRunId) ?? 0;
          if (e.offset > have) {
            const fill = await fetchGap(e.agentRunId, have, e.offset);
            if (fill) {
              send("delta", { type: "delta", taskId: e.taskId, agentRunId: e.agentRunId, text: fill, offset: have });
              have += fill.length;
            }
          }
          send("delta", e);
          known.set(e.agentRunId, Math.max(have, e.offset + e.text.length));
          return;
        }
        if (e.type === "agent" && e.agentRun.status !== "running") known.delete(e.agentRun.id);
        send(e.type, e);
      };
      // Process strictly in order, even when a gap fill has to wait.
      const enqueue = (e: RunEvent) => {
        chain = chain.then(() => (closed ? undefined : handle(e))).catch(() => {});
      };

      const unsubscribe = bus.subscribe(id, (e) => (ready ? enqueue(e) : pending.push(e)));
      const heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup(), { once: true });

      write("retry: 3000\n\n");
      const view = await getTaskView(session.user.id, id);
      if (!view) return cleanup();
      for (const a of view.agentRuns) if (a.status === "running") known.set(a.id, a.partialOutput?.length ?? 0);
      send("snapshot", view);
      ready = true;
      for (const e of pending.splice(0)) enqueue(e);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
