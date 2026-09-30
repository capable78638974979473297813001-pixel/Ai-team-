import { api, ApiError } from "@/server/auth/guard";
import { bus, type RunEvent } from "@/server/orchestrator/events";
import { getTaskView } from "@/server/services/tasks";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events: one `snapshot` with the durable state, then live
 * `run` / `message` / `agent` / `delta` / `tool` events for this task.
 * On reconnect the client simply receives a fresh snapshot.
 */
export const GET = api<true, { id: string }>({ auth: true }, async ({ req, session }, { id }) => {
  const view = await getTaskView(session.user.id, id);
  if (!view) throw new ApiError(404, "Conversation not found");

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      // Subscribe before sending the snapshot so no event falls between them.
      const unsubscribe = bus.subscribe(id, (e: RunEvent) => send(e.type, e));
      send("snapshot", view);
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup(), { once: true });
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
