import type { Finding, RunLimits } from "../db/schema";
import { AuthExpiredError, ProviderError, type ProviderConversation } from "../providers/types";
import type { ActiveConnection } from "../services/connections";
import { metrics } from "../metrics";
import { Budget } from "./budget";
import type { MessageView } from "./events";
import {
  judgePrompt,
  parseJudgement,
  parsePlan,
  parseReview,
  parseWork,
  planPrompt,
  reviewPrompt,
  synthesisPrompt,
  systemPrompt,
  workPrompt,
  type AgentKind,
  type Disagreement,
  type Judgement,
  type Plan,
  type Review,
  type RosterAgent,
} from "./protocol";

export type EngineAgent = RosterAgent & { conn: ActiveConnection; model: string | null };

export type NewMessage = {
  authorType: MessageView["authorType"];
  kind: string;
  content: string;
  agent?: EngineAgent;
  model?: string | null;
  agentRunId?: string | null;
  metadata?: Record<string, unknown>;
  replyToIds?: string[];
};

export type AgentRunPatch = {
  status?: string;
  output?: string;
  summary?: string;
  findings?: Finding[];
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
};

/** Persistence + live-event side of the engine; implemented over Postgres in runner.ts. */
export interface RunSink {
  setRun(patch: { status?: string; phase?: string; round?: number; stopReason?: string | null; error?: string | null }): Promise<void>;
  postMessage(m: NewMessage): Promise<MessageView>;
  startAgentRun(a: {
    agent: EngineAgent;
    kind: AgentKind;
    round: number;
    title: string;
    instructions: string;
    inputMessageIds: string[];
  }): Promise<string>;
  updateAgentRun(id: string, patch: AgentRunPatch): Promise<void>;
  delta(agentRunId: string, text: string): void;
  tool(agentRunId: string, agent: EngineAgent, name: string, status: string, detail?: string): Promise<void>;
  usage(budget: Budget): Promise<void>;
  authExpired(agent: EngineAgent, reason: string): Promise<void>;
}

export type EngineInput = {
  task: string;
  context?: string;
  agents: EngineAgent[];
  limits: RunLimits;
  repoUrl?: string | null;
  allowPullRequests?: boolean;
  signal: AbortSignal;
  sink: RunSink;
  pricing?: ConstructorParameters<typeof Budget>[2];
  now?: () => number;
  retryDelayMs?: number;
};

type WorkItem = {
  subtaskId: string;
  agent: EngineAgent;
  title: string;
  instructions: string;
  verify: boolean;
  webSearch: boolean;
  /** Latest successful output for this subtask. */
  result?: { messageId: string; agentRunId: string; text: string; summary: string; findings: Finding[]; details: string };
};

/** `reviewedMessageId` pins the output version reviewed; a later revision supersedes the review. */
type ReviewRecord = { item: WorkItem; reviewer: EngineAgent; review: Review; messageId: string; reviewedMessageId: string };

const SYNTHESIS_RESERVE = 1;
/** Attempts per provider call for transient failures (429, 5xx, timeouts). */
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 20_000;

/** Exponential backoff with full jitter, honouring the provider's Retry-After (capped). */
export function retryDelay(attempt: number, retryAfterMs: number | null, baseMs = 1500, random = Math.random) {
  if (retryAfterMs != null) return Math.min(MAX_RETRY_WAIT_MS, retryAfterMs);
  const ceiling = Math.min(MAX_RETRY_WAIT_MS, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

export class CancelledError extends Error {}

/**
 * The orchestration engine. It decides which agents are useful, what each
 * receives, which outputs need verification, detects disagreements, decides
 * whether another round is worthwhile, and when to stop.
 *
 * Termination is guaranteed: rounds are bounded by maxRounds, every provider
 * call passes the Budget (calls/runtime/cost), and a round only repeats if the
 * judge asks for it *and* the set of disputes changed since the last round.
 */
export class Orchestrator {
  private budget: Budget;
  private conversations = new Map<string, ProviderConversation>();
  private stopReason: string | null = null;
  private round = 1;

  constructor(private readonly input: EngineInput) {
    this.budget = new Budget(input.limits, (input.now ?? Date.now)(), input.pricing, input.now);
  }

  get usage() {
    return this.budget.usage();
  }

  async run(): Promise<{ status: "completed" | "failed"; stopReason: string | null }> {
    const { sink } = this.input;
    const agents = this.input.agents.slice(0, this.input.limits.maxAgents);
    if (!agents.length) throw new Error("No connected agents are available for this task");

    // ---- PLAN
    await sink.setRun({ status: "running", phase: "plan", round: 1 });
    const lead = this.pickLead(agents);
    const plan = await this.plan(lead, agents);
    const items = this.buildWorkItems(plan, agents);
    await sink.postMessage({
      authorType: "orchestrator",
      kind: "plan",
      content: plan.summary || `Splitting the task across ${items.length} agent${items.length === 1 ? "" : "s"}.`,
      metadata: { lead: lead.key, subtasks: items.map((i) => ({ agent: i.agent.key, title: i.title })) },
    });

    // ---- DELEGATE
    await sink.setRun({ phase: "delegate" });
    for (const item of items) {
      await sink.postMessage({
        authorType: "orchestrator",
        kind: "assignment",
        content: item.instructions,
        metadata: {
          assignee: item.agent.key,
          assigneeName: item.agent.name,
          assigneeRole: item.agent.roleTitle,
          title: item.title,
          verify: item.verify,
          webSearch: item.webSearch,
        },
      });
    }

    // ---- AGENTS WORK
    await sink.setRun({ phase: "work" });
    await Promise.all(items.map((item) => this.doWork(item)));
    const productive = items.filter((i) => i.result);
    if (!productive.length) {
      await sink.postMessage({
        authorType: "orchestrator",
        kind: "status",
        content: "None of the agents could complete their assignments, so there is nothing to synthesise.",
      });
      return { status: "failed", stopReason: this.stopReason ?? "every agent failed" };
    }

    // ---- CROSS-REVIEW → RESOLVE, bounded rounds
    const allReviews: ReviewRecord[] = [];
    const rulings: { claim: string; ruling: string; resolution: string }[] = [];
    let toReview = productive;
    let lastSignature = "";

    while (true) {
      await sink.setRun({ phase: "review", round: this.round });
      const reviews = await this.crossReview(toReview, agents);
      allReviews.push(...reviews);
      const disputes = findDisagreements(reviews);
      if (!disputes.length) {
        if (reviews.length) {
          await sink.postMessage({
            authorType: "orchestrator",
            kind: "status",
            content: "Reviewers found no material disagreements.",
          });
        }
        break;
      }

      await sink.postMessage({
        authorType: "orchestrator",
        kind: "disagreement",
        content: `${disputes.length} disagreement${disputes.length === 1 ? "" : "s"} to resolve.`,
        metadata: { disagreements: disputes },
        replyToIds: reviews.map((r) => r.messageId),
      });

      await sink.setRun({ phase: "resolve" });
      const judge = this.pickJudge(agents, disputes, lead);
      const judgement = judge ? await this.judge(judge, disputes, reviews) : null;
      if (!judgement) break;
      for (const r of judgement.rulings) {
        const d = disputes.find((x) => x.id === r.id);
        if (d) rulings.push({ claim: d.claim, ruling: r.ruling, resolution: r.resolution });
      }

      // Decide whether another round is worthwhile.
      const signature = disputes.map((d) => `${d.authorKey}:${d.claim}`).sort().join("|");
      const followUps = judgement.followUps
        .map((f) => ({ ...f, item: items.find((i) => i.agent.key === f.agent && i.result) }))
        .filter((f): f is typeof f & { item: WorkItem } => !!f.item);
      const reason = !judgement.anotherRound
        ? null
        : this.round >= this.input.limits.maxRounds
          ? `the round limit (${this.input.limits.maxRounds}) was reached`
          : !followUps.length
            ? "the judge named no agent to revise"
            : signature === lastSignature
              ? "the same disagreements repeated, so another round would not help"
              : this.budget.exhaustedReason(SYNTHESIS_RESERVE + followUps.length);
      if (!judgement.anotherRound) break;
      if (reason) {
        this.stopReason ??= reason;
        await sink.postMessage({ authorType: "orchestrator", kind: "status", content: `Not running another round: ${reason}.` });
        break;
      }

      lastSignature = signature;
      this.round++;
      await sink.setRun({ phase: "work", round: this.round });
      await sink.postMessage({
        authorType: "orchestrator",
        kind: "status",
        content: `Round ${this.round}: asking ${followUps.map((f) => f.item.agent.name).join(", ")} to revise after the rulings.`,
      });
      const rulingText = judgement.rulings.map((r) => `${r.id}: ${r.ruling} — ${r.resolution}`).join("\n");
      await Promise.all(
        followUps.map((f) =>
          this.doWork(f.item, { rulings: `${rulingText}\n\nJudge's request: ${f.instructions}`, ownOutput: f.item.result!.text }),
        ),
      );
      toReview = followUps.map((f) => f.item);
    }

    // ---- FINAL SYNTHESIS
    await sink.setRun({ phase: "synthesize" });
    await this.synthesize(lead, agents, items, allReviews, rulings);
    return { status: "completed", stopReason: this.stopReason };
  }

  // ------------------------------------------------------------ decisions

  private pickLead(agents: EngineAgent[]) {
    const chat = agents.filter((a) => a.capabilities.includes("chat"));
    return (
      chat.find((a) => a.isLead) ??
      chat.find((a) => a.capabilities.includes("reasoning")) ??
      chat[0] ??
      agents[0]!
    );
  }

  private pickJudge(agents: EngineAgent[], disputes: Disagreement[], lead: EngineAgent) {
    const involved = new Set(disputes.flatMap((d) => [d.authorKey, d.reviewerKey]));
    const chat = agents.filter((a) => a.capabilities.includes("chat"));
    const judgeLike = (a: EngineAgent) => /judge|review|critic|arbiter/i.test(`${a.roleTitle} ${a.roleInstructions}`);
    return (
      chat.find((a) => !involved.has(a.key) && judgeLike(a)) ??
      chat.find((a) => !involved.has(a.key)) ??
      (chat.includes(lead) ? lead : undefined) ??
      chat[0]
    );
  }

  private async plan(lead: EngineAgent, agents: EngineAgent[]): Promise<Plan> {
    if (agents.length > 1 && lead.capabilities.includes("chat") && this.budget.canCall(SYNTHESIS_RESERVE + agents.length)) {
      const res = await this.callAgent(lead, "plan", "Plan the work", "Decide which teammates to involve and what each should do.", planPrompt({
        task: this.input.task,
        roster: agents,
        maxAgents: this.input.limits.maxAgents,
        hasRepo: !!this.input.repoUrl,
        context: this.input.context,
      }), { silentOutput: true });
      const parsed = res ? parsePlan(res.text) : null;
      if (parsed) return parsed;
    }
    return heuristicPlan(this.input.task, agents, !!this.input.repoUrl);
  }

  private buildWorkItems(plan: Plan, agents: EngineAgent[]): WorkItem[] {
    const byKey = new Map(agents.map((a) => [a.key, a]));
    const used = new Set<string>();
    const items: WorkItem[] = [];
    for (const [i, s] of plan.subtasks.entries()) {
      const agent = byKey.get(s.agent);
      if (!agent || used.has(agent.key)) continue;
      if (agent.capabilities.includes("repository_access") && !agent.capabilities.includes("chat") && !this.input.repoUrl) continue;
      used.add(agent.key);
      items.push({
        subtaskId: `s${i + 1}`,
        agent,
        title: s.title.slice(0, 120),
        instructions: s.instructions.slice(0, 4000),
        verify: s.verify,
        webSearch: s.webSearch && agent.capabilities.includes("web_research"),
      });
      if (items.length >= this.input.limits.maxAgents) break;
    }
    return items.length ? items : heuristicPlan(this.input.task, agents, !!this.input.repoUrl).subtasks.map((s, i) => ({
      subtaskId: `s${i + 1}`,
      agent: byKey.get(s.agent)!,
      title: s.title,
      instructions: s.instructions,
      verify: s.verify,
      webSearch: s.webSearch,
    }));
  }

  // ------------------------------------------------------------ phases

  private async doWork(item: WorkItem, revision?: { rulings: string; ownOutput: string }) {
    const prompt = workPrompt({
      task: this.input.task,
      title: item.title,
      instructions: item.instructions,
      context: this.input.context,
      revision,
    });
    const res = await this.callAgent(item.agent, "work", revision ? `${item.title} (revision)` : item.title, item.instructions, prompt, {
      webSearch: item.webSearch,
      persistentConversation: `work:${item.subtaskId}`,
      replyToIds: revision && item.result ? [item.result.messageId] : [],
    });
    if (!res) return;
    const parsed = parseWork(res.text);
    await this.input.sink.updateAgentRun(res.agentRunId, { summary: parsed.summary, findings: parsed.findings });
    const msg = await this.input.sink.postMessage({
      authorType: "agent",
      kind: "output",
      content: res.text,
      agent: item.agent,
      model: res.model,
      agentRunId: res.agentRunId,
      metadata: { title: item.title, summary: parsed.summary, findings: parsed.findings, round: this.round, revision: !!revision },
      replyToIds: res.replyToIds,
    });
    item.result = { messageId: msg.id, agentRunId: res.agentRunId, text: res.text, ...parsed };
  }

  private async crossReview(items: WorkItem[], agents: EngineAgent[]): Promise<ReviewRecord[]> {
    const reviewers = agents.filter((a) => a.capabilities.includes("chat"));
    const targets = items.filter((i) => i.verify && i.result && i.result.findings.length);
    if (reviewers.length < 2 && !(reviewers.length === 1 && targets.some((t) => t.agent.key !== reviewers[0]!.key))) return [];

    const load = new Map<string, number>();
    const assignments: { item: WorkItem; reviewer: EngineAgent }[] = [];
    for (const item of targets) {
      const candidates = reviewers.filter((r) => r.key !== item.agent.key);
      if (!candidates.length) continue;
      // Prefer critic/reviewer roles, then whoever has reviewed least.
      candidates.sort((a, b) => {
        const crit = (x: EngineAgent) => (/review|critic|judge|verif/i.test(`${x.roleTitle} ${x.roleInstructions}`) ? -1 : 0);
        return crit(a) - crit(b) || (load.get(a.key) ?? 0) - (load.get(b.key) ?? 0);
      });
      const reviewer = candidates[0]!;
      load.set(reviewer.key, (load.get(reviewer.key) ?? 0) + 1);
      assignments.push({ item, reviewer });
    }

    const out: ReviewRecord[] = [];
    await Promise.all(
      assignments.map(async ({ item, reviewer }) => {
        if (!this.budget.canCall(SYNTHESIS_RESERVE)) {
          this.stopReason ??= this.budget.exhaustedReason(SYNTHESIS_RESERVE);
          return;
        }
        const r = item.result!;
        const res = await this.callAgent(
          reviewer,
          "review",
          `Review ${item.agent.name}'s ${item.title}`,
          `Check ${r.findings.length} findings from ${item.agent.name}.`,
          reviewPrompt({
            task: this.input.task,
            authorName: item.agent.name,
            authorRole: item.agent.roleTitle,
            title: item.title,
            findings: r.findings,
            summary: r.summary,
          }),
          { replyToIds: [r.messageId], silentOutput: true },
        );
        if (!res) return;
        const review = parseReview(res.text);
        await this.input.sink.updateAgentRun(res.agentRunId, { summary: review.summary });
        const msg = await this.input.sink.postMessage({
          authorType: "agent",
          kind: "review",
          content: formatReview(review, r.findings),
          agent: reviewer,
          model: res.model,
          agentRunId: res.agentRunId,
          metadata: { reviewOf: item.agent.key, reviewOfName: item.agent.name, title: item.title, review, round: this.round },
          replyToIds: [r.messageId],
        });
        out.push({ item, reviewer, review, messageId: msg.id, reviewedMessageId: r.messageId });
      }),
    );
    return out;
  }

  private async judge(judge: EngineAgent, disputes: Disagreement[], reviews: ReviewRecord[]): Promise<Judgement | null> {
    if (!this.budget.canCall(SYNTHESIS_RESERVE)) {
      this.stopReason ??= this.budget.exhaustedReason(SYNTHESIS_RESERVE);
      return null;
    }
    const inputs = [...new Set(reviews.flatMap((r) => [r.item.result!.messageId, r.messageId]))];
    const res = await this.callAgent(
      judge,
      "judge",
      "Resolve disagreements",
      `Rule on ${disputes.length} disputed point${disputes.length === 1 ? "" : "s"}.`,
      judgePrompt({
        task: this.input.task,
        disagreements: disputes,
        round: this.round,
        maxRounds: this.input.limits.maxRounds,
        agents: this.input.agents,
      }),
      { replyToIds: inputs, silentOutput: true },
    );
    if (!res) return null;
    const judgement = parseJudgement(res.text);
    await this.input.sink.updateAgentRun(res.agentRunId, { summary: judgement.summary });
    await this.input.sink.postMessage({
      authorType: "agent",
      kind: "ruling",
      content: formatJudgement(judgement, disputes),
      agent: judge,
      model: res.model,
      agentRunId: res.agentRunId,
      metadata: { judgement, disagreements: disputes, round: this.round },
      replyToIds: inputs,
    });
    return judgement;
  }

  private async synthesize(
    lead: EngineAgent,
    agents: EngineAgent[],
    items: WorkItem[],
    reviews: ReviewRecord[],
    rulings: { claim: string; ruling: string; resolution: string }[],
  ) {
    const done = items.filter((i) => i.result);
    // Reviews of outputs that were later revised are superseded; the judge's rulings carry that history.
    reviews = reviews.filter((r) => r.reviewedMessageId === r.item.result?.messageId);
    const prompt = synthesisPrompt({
      task: this.input.task,
      context: this.input.context,
      work: done.map((i) => ({
        name: i.agent.name,
        role: i.agent.roleTitle,
        title: i.title,
        summary: i.result!.summary,
        findings: i.result!.findings,
        details: i.result!.details,
      })),
      reviews: reviews.map((r) => ({
        reviewer: r.reviewer.name,
        author: r.item.agent.name,
        summary: r.review.summary,
        flagged: r.review.reviews.filter((v) => v.verdict === "incorrect" || v.verdict === "incomplete").map((v) => `${v.finding} ${v.verdict}: ${v.note}`),
      })),
      rulings,
      stopReason: this.stopReason ?? undefined,
    });
    const inputs = [...done.map((i) => i.result!.messageId), ...reviews.map((r) => r.messageId)];
    const candidates = [lead, ...agents.filter((a) => a !== lead)].filter((a) => a.capabilities.includes("chat"));

    for (const agent of candidates) {
      if (!this.budget.canSynthesize()) break;
      const res = await this.callAgent(agent, "synthesis", "Final synthesis", "Combine the team's work into one answer.", prompt, {
        replyToIds: inputs,
        // The final answer streams to the user token by token.
        silentOutput: false,
        ignoreRuntime: true,
      });
      if (!res) continue;
      await this.input.sink.postMessage({
        authorType: "agent",
        kind: "final",
        content: res.text,
        agent,
        model: res.model,
        agentRunId: res.agentRunId,
        metadata: { synthesizedFrom: done.map((i) => i.agent.key), stopReason: this.stopReason },
        replyToIds: inputs,
      });
      return;
    }

    // Deterministic fallback so the user always gets the team's findings.
    await this.input.sink.postMessage({
      authorType: "orchestrator",
      kind: "final",
      content: [
        "No agent was available to write the final synthesis, so here are the team's findings as reported.",
        "",
        ...done.map((i) => `**${i.agent.name} — ${i.title}.** ${i.result!.summary}\n${i.result!.findings.map((f) => `- ${f.text}`).join("\n")}`),
        rulings.length ? `\n**Rulings**\n${rulings.map((r) => `- ${r.claim} → ${r.ruling}: ${r.resolution}`).join("\n")}` : "",
      ].join("\n"),
      replyToIds: inputs,
    });
  }

  // ------------------------------------------------------------ calling

  private async callAgent(
    agent: EngineAgent,
    kind: AgentKind,
    title: string,
    instructions: string,
    prompt: string,
    opts: {
      webSearch?: boolean;
      replyToIds?: string[];
      persistentConversation?: string;
      silentOutput?: boolean;
      ignoreRuntime?: boolean;
    } = {},
  ): Promise<{ text: string; model: string; agentRunId: string; replyToIds: string[] } | null> {
    const { sink, signal } = this.input;
    if (signal.aborted) throw new CancelledError();
    const reserve = kind === "synthesis" ? 0 : SYNTHESIS_RESERVE;
    const blocked = kind === "synthesis" ? (this.budget.canSynthesize() ? null : "the call limit was reached") : this.budget.exhaustedReason(reserve);
    if (blocked) {
      this.stopReason ??= blocked;
      return null;
    }

    const agentRunId = await sink.startAgentRun({
      agent,
      kind,
      round: this.round,
      title,
      instructions,
      inputMessageIds: opts.replyToIds ?? [],
    });

    const { adapter, credentials } = agent.conn;
    let conversation = opts.persistentConversation ? this.conversations.get(`${agent.key}:${opts.persistentConversation}`) : undefined;
    if (!conversation) {
      conversation = await adapter.createConversation(credentials, {
        model: agent.model ?? agent.conn.defaultModel,
        system: systemPrompt(agent, this.input.agents, kind),
      });
      if (opts.persistentConversation) this.conversations.set(`${agent.key}:${opts.persistentConversation}`, conversation);
    }

    const timeoutMs = opts.ignoreRuntime ? 3 * 60_000 : Math.max(15_000, this.budget.remainingMs());
    let attempt = 0;
    while (true) {
      attempt++;
      this.budget.begin();
      await sink.usage(this.budget);
      const callSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const callStarted = performance.now();
      const observe = (outcome: string) => {
        metrics.providerCalls.inc({ provider: agent.provider, kind, outcome });
        metrics.providerDuration.observe({ provider: agent.provider, kind }, (performance.now() - callStarted) / 1000);
      };
      try {
        let done: { text: string; model: string; usage: { inputTokens: number; outputTokens: number } } | null = null;
        for await (const chunk of adapter.streamMessage(credentials, conversation, prompt, {
          signal: callSignal,
          webSearch: opts.webSearch,
          repoUrl: this.input.repoUrl,
          allowPullRequests: this.input.allowPullRequests,
        })) {
          if (chunk.type === "delta") {
            if (!opts.silentOutput) sink.delta(agentRunId, chunk.text);
          } else if (chunk.type === "tool") {
            await sink.tool(agentRunId, agent, chunk.name, chunk.status, chunk.detail);
          } else if (chunk.type === "done") {
            done = chunk;
          }
        }
        if (!done) throw new ProviderError(agent.provider, null, "Response ended without completing", true);
        this.budget.record(agent.provider, done.model, done.usage);
        observe("ok");
        metrics.providerTokens.inc({ provider: agent.provider, direction: "input" }, done.usage.inputTokens);
        metrics.providerTokens.inc({ provider: agent.provider, direction: "output" }, done.usage.outputTokens);
        await sink.usage(this.budget);
        await sink.updateAgentRun(agentRunId, { status: "completed", output: done.text, model: done.model, usage: done.usage });
        return { text: done.text, model: done.model, agentRunId, replyToIds: opts.replyToIds ?? [] };
      } catch (err) {
        observe(signal.aborted ? "cancelled" : err instanceof AuthExpiredError ? "auth_expired" : "error");
        if (signal.aborted) {
          await adapter.cancel(credentials, conversation).catch(() => {});
          await sink.updateAgentRun(agentRunId, { status: "cancelled" });
          throw new CancelledError();
        }
        if (err instanceof AuthExpiredError) {
          await sink.updateAgentRun(agentRunId, { status: "failed", error: "Authorization expired" });
          await sink.authExpired(agent, err.message);
          return null;
        }
        const retryable = (err instanceof ProviderError && err.retryable) || (err as Error)?.name === "TimeoutError";
        if (retryable && attempt < MAX_ATTEMPTS && this.budget.canCall(reserve)) {
          const wait = retryDelay(attempt, err instanceof ProviderError ? err.retryAfterMs : null, this.input.retryDelayMs);
          if (wait <= this.budget.remainingMs() || opts.ignoreRuntime) {
            await sink.tool(agentRunId, agent, "retry", "started", `${(err as Error).message} — retrying in ${Math.round(wait / 1000)}s`);
            await abortableSleep(wait, signal);
            if (signal.aborted) {
              await sink.updateAgentRun(agentRunId, { status: "cancelled" });
              throw new CancelledError();
            }
            continue;
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        await sink.updateAgentRun(agentRunId, { status: "failed", error: message.slice(0, 500) });
        await sink.postMessage({
          authorType: "system",
          kind: "status",
          content: `${agent.name} couldn't finish "${title}": ${message.slice(0, 300)}`,
          agent,
          agentRunId,
        });
        return null;
      }
    }
  }
}

// ------------------------------------------------------------ pure helpers

export function heuristicPlan(task: string, agents: EngineAgent[] | RosterAgent[], hasRepo: boolean): Plan {
  const needsWeb = /\b(latest|current|today|news|recent|price|market|2025|2026|compare|research)\b/i.test(task);
  const usable = agents.filter((a) => hasRepo || !(a.capabilities.includes("repository_access") && !a.capabilities.includes("chat")));
  return {
    summary: `Each teammate takes the task from their role, then they review each other.`,
    subtasks: usable.map((a) => ({
      agent: a.key,
      title: a.roleTitle,
      instructions: `${a.roleInstructions || `Contribute as the ${a.roleTitle}.`}\nApply this to the user's task and report specific, checkable findings.`,
      verify: true,
      webSearch: needsWeb && a.capabilities.includes("web_research"),
    })),
  };
}

export function findDisagreements(reviews: ReviewRecord[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const r of reviews) {
    for (const v of r.review.reviews) {
      if (v.verdict !== "incorrect" && v.verdict !== "incomplete") continue;
      const f = r.item.result?.findings.find((x) => x.id === v.finding);
      if (!f) continue;
      out.push({
        id: `D${out.length + 1}`,
        subtaskTitle: r.item.title,
        findingId: f.id,
        claim: f.text,
        authorKey: r.item.agent.key,
        authorName: r.item.agent.name,
        reviewerKey: r.reviewer.key,
        reviewerName: r.reviewer.name,
        verdict: v.verdict,
        objection: v.note,
      });
    }
  }
  return out.slice(0, 12);
}

function formatReview(review: Review, findings: Finding[]) {
  const lines = [review.summary];
  for (const v of review.reviews) {
    const f = findings.find((x) => x.id === v.finding);
    lines.push(`- **${v.finding} · ${v.verdict}**${f ? ` — ${truncate(f.text, 120)}` : ""}${v.note ? `\n  ${v.note}` : ""}`);
  }
  if (review.missing.length) lines.push("", "Missing:", ...review.missing.map((m) => `- ${m}`));
  return lines.join("\n");
}

function formatJudgement(j: Judgement, disputes: Disagreement[]) {
  const lines = [j.summary];
  for (const r of j.rulings) {
    const d = disputes.find((x) => x.id === r.id);
    lines.push(`- **${r.id} · ${rulingLabel(r.ruling, d)}**${d ? ` — ${truncate(d.claim, 120)}` : ""}${r.resolution ? `\n  ${r.resolution}` : ""}`);
  }
  return lines.join("\n");
}

function rulingLabel(ruling: string, d?: Disagreement) {
  if (!d) return ruling;
  if (ruling === "author") return `sides with ${d.authorName}`;
  if (ruling === "reviewer") return `sides with ${d.reviewerName}`;
  return ruling;
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
