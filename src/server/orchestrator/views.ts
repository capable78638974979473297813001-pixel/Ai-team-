import type { agentRuns, messages, taskRuns } from "../db/schema";
import type { AgentRunView, MessageView, RunView } from "./events";

export function toMessageView(m: typeof messages.$inferSelect): MessageView {
  return {
    id: m.id,
    seq: m.seq,
    taskRunId: m.taskRunId,
    agentRunId: m.agentRunId,
    authorType: m.authorType as MessageView["authorType"],
    provider: m.provider,
    model: m.model,
    agentKey: m.agentKey,
    roleTitle: m.roleTitle,
    kind: m.kind,
    content: m.content,
    metadata: m.metadata,
    replyToIds: m.replyToIds,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toAgentRunView(a: typeof agentRuns.$inferSelect): AgentRunView {
  return {
    id: a.id,
    taskRunId: a.taskRunId,
    agentKey: a.agentKey,
    provider: a.provider,
    model: a.model,
    roleTitle: a.roleTitle,
    kind: a.kind,
    round: a.round,
    title: a.title,
    status: a.status,
    summary: a.summary,
    error: a.error,
    startedAt: a.startedAt?.toISOString() ?? null,
    finishedAt: a.finishedAt?.toISOString() ?? null,
  };
}

export function toRunView(r: typeof taskRuns.$inferSelect): RunView {
  return {
    id: r.id,
    status: r.status,
    phase: r.phase,
    round: r.round,
    usage: r.usage,
    stopReason: r.stopReason,
    error: r.error,
    limits: r.limits,
  };
}
