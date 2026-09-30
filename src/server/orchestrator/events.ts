import type { RunUsage } from "../db/schema";
import { INSTANCE_ID } from "../instance";

export type MessageView = {
  id: string;
  seq: number;
  taskRunId: string | null;
  agentRunId: string | null;
  authorType: "user" | "orchestrator" | "agent" | "system";
  provider: string | null;
  model: string | null;
  agentKey: string | null;
  roleTitle: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  replyToIds: string[];
  createdAt: string;
};

export type AgentRunView = {
  id: string;
  taskRunId: string;
  agentKey: string;
  provider: string;
  model: string | null;
  roleTitle: string;
  kind: string;
  round: number;
  title: string;
  status: string;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunView = {
  id: string;
  status: string;
  phase: string;
  round: number;
  usage: RunUsage;
  stopReason: string | null;
  error: string | null;
  limits: { maxRounds: number; maxAgents: number; maxCalls: number; maxRuntimeMs: number; maxCostUsd: number | null };
};

export type RunEvent =
  | { type: "run"; taskId: string; run: RunView }
  | { type: "message"; taskId: string; message: MessageView }
  | { type: "agent"; taskId: string; agentRun: AgentRunView }
  | { type: "delta"; taskId: string; agentRunId: string; text: string }
  | { type: "tool"; taskId: string; agentRunId: string; name: string; status: string; detail?: string };

type Listener = (e: RunEvent) => void;

/** Carries events to other app instances. */
export interface EventTransport {
  send(e: RunEvent): void;
}

/**
 * Pub/sub keyed by task. Durable state lives in Postgres; the bus only carries
 * live updates to open SSE connections. With a transport installed (Postgres
 * LISTEN/NOTIFY, see pg-coordination.ts) events also reach subscribers on
 * other instances.
 */
class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private transport: EventTransport | null = null;
  readonly instanceId = INSTANCE_ID;

  setTransport(t: EventTransport | null) {
    this.transport = t;
  }

  hasTransport() {
    return !!this.transport;
  }

  subscribe(taskId: string, fn: Listener) {
    let set = this.listeners.get(taskId);
    if (!set) this.listeners.set(taskId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(taskId);
    };
  }

  /** Publish from this instance: deliver locally and forward to other instances. */
  publish(e: RunEvent) {
    this.deliver(e);
    this.transport?.send(e);
  }

  /** Deliver to local subscribers only (used for events received from other instances). */
  deliver(e: RunEvent) {
    for (const fn of this.listeners.get(e.taskId) ?? []) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not break the run */
      }
    }
  }

  hasSubscribers(taskId: string) {
    return this.listeners.has(taskId);
  }
}

const g = globalThis as unknown as { __aiteamBus?: EventBus };
export const bus = (g.__aiteamBus ??= new EventBus());
