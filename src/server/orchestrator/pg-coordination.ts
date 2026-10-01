import { eq } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db/client";
import { messages } from "../db/schema";
import { env } from "../env";
import { INSTANCE_ID } from "../instance";
import { log } from "../security/redact";
import { bus, type RunEvent } from "./events";
import { toMessageView } from "./views";

/**
 * Cross-instance coordination over Postgres LISTEN/NOTIFY:
 *  - `aiteam_events`: live run events, so an SSE client connected to instance A
 *    sees a run executing on instance B;
 *  - `aiteam_cancel`: cancel requests, delivered to whichever instance owns the run.
 *
 * NOTIFY payloads are capped (~8KB), so large messages are sent as a reference
 * and loaded from the database by the receiver. Notifies go through a single
 * connection so their order is preserved.
 */
const EVENTS = "aiteam_events";
const CANCEL = "aiteam_cancel";
const MAX_PAYLOAD = 7_500;
const COALESCE_MS = 25;
/** JSON escaping can double text size; keep merged deltas well under the NOTIFY limit. */
const MAX_COALESCED_CHARS = 2_500;

type Envelope = { o: string; t: string; e?: RunEvent; ref?: { messageId: string } };

const g = globalThis as unknown as { __aiteamPg?: postgres.Sql };

export async function startPgCoordination(onCancel: (runId: string) => void) {
  if (g.__aiteamPg) return;
  const url = env().DATABASE_URL;
  if (!url) throw new Error("EVENT_BUS=postgres requires DATABASE_URL");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  g.__aiteamPg = sql;

  await sql.listen(EVENTS, (payload) => {
    void receive(payload);
  });
  await sql.listen(CANCEL, (runId) => {
    if (/^[0-9a-f-]{36}$/i.test(runId)) onCancel(runId);
  });

  // Deltas are tiny and frequent. Coalesce consecutive ones per agent run for a
  // few ms before NOTIFY; offsets make the merged event exactly equivalent.
  const pendingDeltas = new Map<string, Extract<RunEvent, { type: "delta" }>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDeltas = () => {
    flushTimer = null;
    const batch = [...pendingDeltas.values()];
    pendingDeltas.clear();
    for (const d of batch) sendNow(d);
  };

  const sendNow = (e: RunEvent) => {
    let payload = JSON.stringify({ o: INSTANCE_ID, t: e.taskId, e } satisfies Envelope);
    if (payload.length > MAX_PAYLOAD) {
      if (e.type !== "message") {
        // Receivers' gap filling recovers dropped delta text from the database.
        log.warn(`dropping oversized ${e.type} event from cross-instance fan-out`);
        return;
      }
      payload = JSON.stringify({ o: INSTANCE_ID, t: e.taskId, ref: { messageId: e.message.id } } satisfies Envelope);
    }
    sql.notify(EVENTS, payload).catch((err) => log.error("notify failed", err));
  };

  bus.setTransport({
    send(e) {
      if (e.type === "delta") {
        const prev = pendingDeltas.get(e.agentRunId);
        if (prev && prev.offset + prev.text.length === e.offset && prev.text.length + e.text.length < MAX_COALESCED_CHARS) {
          prev.text += e.text;
        } else {
          if (prev) sendNow(prev);
          pendingDeltas.set(e.agentRunId, { ...e });
        }
        flushTimer ??= setTimeout(flushDeltas, COALESCE_MS);
        return;
      }
      // Anything else must not overtake buffered text from the same run.
      if (pendingDeltas.size) {
        if (flushTimer) clearTimeout(flushTimer);
        flushDeltas();
      }
      sendNow(e);
    },
  });
  log.info(`cross-instance coordination enabled (instance ${INSTANCE_ID})`);
}

async function receive(payload: string) {
  let env: Envelope;
  try {
    env = JSON.parse(payload);
  } catch {
    return;
  }
  if (env.o === INSTANCE_ID || !bus.hasSubscribers(env.t)) return;
  if (env.e) {
    bus.deliver(env.e);
    return;
  }
  if (env.ref) {
    const [row] = await db().select().from(messages).where(eq(messages.id, env.ref.messageId));
    if (row) bus.deliver({ type: "message", taskId: env.t, message: toMessageView(row) });
  }
}

export async function notifyCancel(runId: string) {
  await g.__aiteamPg?.notify(CANCEL, runId);
}

export async function stopPgCoordination() {
  bus.setTransport(null);
  await g.__aiteamPg?.end({ timeout: 5 });
  g.__aiteamPg = undefined;
}
