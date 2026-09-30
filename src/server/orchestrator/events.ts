import type { RunUsage } from "../db/schema";

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

/**
 * In-process pub/sub keyed by task. Durable state lives in Postgres; this only
 * carries live updates to open SSE connections. For multiple app instances,
 * replace with Postgres LISTEN/NOTIFY or Redis pub/sub behind this interface.
 */
class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(taskId: string, fn: Listener) {
    let set = this.listeners.get(taskId);
    if (!set) this.listeners.set(taskId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(taskId);
    };
  }

  publish(e: RunEvent) {
    for (const fn of this.listeners.get(e.taskId) ?? []) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not break the run */
      }
    }
  }
}

const g = globalThis as unknown as { __aiteamBus?: EventBus };
export const bus = (g.__aiteamBus ??= new EventBus());
