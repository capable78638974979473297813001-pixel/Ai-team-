import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@/server/orchestrator/budget";
import { Orchestrator, type EngineAgent, type RunSink } from "@/server/orchestrator/engine";
import type { MessageView } from "@/server/orchestrator/events";
import { getAdapter } from "@/server/providers/registry";
import { SandboxAdapter, sandboxTiming } from "@/server/providers/sandbox";
import { AuthExpiredError, ProviderError, type Credentials, type ProviderConversation, type ProviderId, type SendOptions, type StreamChunk } from "@/server/providers/types";

sandboxTiming.tokenDelayMs = 0;

/** Sandbox agent that records every prompt and can be told to fail. */
class ScriptedAdapter extends SandboxAdapter {
  prompts: { kind: string; message: string }[] = [];
  failures: Error[] = [];
  constructor(id: ProviderId) {
    super(getAdapter(id));
  }
  override async *streamMessage(c: Credentials, conv: ProviderConversation, message: string, opts?: SendOptions): AsyncGenerator<StreamChunk> {
    this.prompts.push({ kind: conv.system.match(/\[protocol:(\w+)\]/)?.[1] ?? "?", message });
    const fail = this.failures.shift();
    if (fail) throw fail;
    yield* super.streamMessage(c, conv, message, opts);
  }
}

function agent(id: ProviderId, roleTitle: string, isLead = false) {
  const adapter = new ScriptedAdapter(id);
  const a: EngineAgent = {
    key: id,
    name: getAdapter(id).info.name,
    provider: id,
    roleTitle,
    roleInstructions: "",
    capabilities: adapter.capabilities(),
    isLead,
    model: null,
    conn: { provider: id, adapter, credentials: { method: "sandbox", accessToken: "x", scopes: [], extra: {} }, defaultModel: "sandbox", capabilities: adapter.capabilities(), simulated: true },
  };
  return { a, adapter };
}

class MemorySink implements RunSink {
  messages: MessageView[] = [];
  runs: { id: string; status: string; error?: string }[] = [];
  expired: string[] = [];
  async setRun() {}
  async postMessage(m: Parameters<RunSink["postMessage"]>[0]) {
    const v: MessageView = {
      id: `m${this.messages.length + 1}`,
      seq: this.messages.length + 1,
      taskRunId: "r",
      agentRunId: m.agentRunId ?? null,
      authorType: m.authorType,
      provider: m.agent?.provider ?? null,
      model: m.model ?? null,
      agentKey: m.agent?.key ?? null,
      roleTitle: m.agent?.roleTitle ?? null,
      kind: m.kind,
      content: m.content,
      metadata: m.metadata ?? {},
      replyToIds: m.replyToIds ?? [],
      createdAt: new Date().toISOString(),
    };
    this.messages.push(v);
    return v;
  }
  async startAgentRun() {
    const id = `ar${this.runs.length + 1}`;
    this.runs.push({ id, status: "running" });
    return id;
  }
  async updateAgentRun(id: string, patch: { status?: string; error?: string }) {
    const r = this.runs.find((x) => x.id === id)!;
    if (patch.status) r.status = patch.status;
    if (patch.error) r.error = patch.error;
  }
  delta() {}
  async tool() {}
  async usage() {}
  async authExpired(a: EngineAgent) {
    this.expired.push(a.key);
  }
}

const run = (agents: EngineAgent[], limits = DEFAULT_LIMITS) => {
  const sink = new MemorySink();
  const o = new Orchestrator({ task: "Is this design sound?", agents, limits, signal: new AbortController().signal, sink, retryDelayMs: 1 });
  return { sink, o, done: o.run() };
};

describe("engine", () => {
  it("sends each reviewer the author's findings and keeps superseded reviews out of the synthesis", async () => {
    const team = [agent("openai", "Architect", true), agent("anthropic", "Developer"), agent("google", "Reviewer"), agent("xai", "Researcher")];
    const { sink, done } = run(team.map((t) => t.a), { ...DEFAULT_LIMITS, maxRounds: 2, maxCalls: 40 });
    expect((await done).status).toBe("completed");

    const reviews = team.flatMap((t) => t.adapter.prompts.filter((p) => p.kind === "review"));
    expect(reviews.length).toBeGreaterThan(0);
    for (const r of reviews) expect(r.message).toMatch(/\[F1\]/);

    // Only reviews of each agent's *latest* output may reach the synthesis prompt.
    const latest = new Map<string, string>();
    for (const m of sink.messages) if (m.kind === "output" && m.agentKey) latest.set(m.agentKey, m.id);
    const allReviews = sink.messages.filter((m) => m.kind === "review");
    const current = allReviews.filter((m) => m.replyToIds[0] === latest.get(String(m.metadata.reviewOf)));
    const synthesis = team.flatMap((t) => t.adapter.prompts).find((p) => p.kind === "synthesis")!;
    const listed = synthesis.message.split("Cross-reviews:")[1]?.split("\n\n")[0]?.match(/^- .+ on .+: /gm) ?? [];
    expect(sink.messages.some((m) => m.kind === "output" && m.metadata.revision)).toBe(true); // a revision round happened
    expect(allReviews.length).toBeGreaterThan(current.length);
    expect(listed).toHaveLength(current.length);
    expect(sink.messages.at(-1)!.kind).toBe("final");
  });

  it("retries transient provider errors and charges each attempt to the budget", async () => {
    const lead = agent("openai", "Lead", true);
    const dev = agent("anthropic", "Developer");
    dev.adapter.failures.push(new ProviderError("Anthropic", 529, "overloaded", true, 1));
    const { o, sink, done } = run([lead.a, dev.a]);
    expect((await done).status).toBe("completed");
    expect(dev.adapter.prompts.filter((p) => p.kind === "work")).toHaveLength(2);
    expect(sink.messages.some((m) => m.kind === "output" && m.provider === "anthropic")).toBe(true);
    expect(o.usage.calls).toBe(sink.runs.length + 1); // one agent run, two attempts
  });

  it("does not retry non-retryable errors and reports them in the thread", async () => {
    const lead = agent("openai", "Lead", true);
    const dev = agent("anthropic", "Developer");
    dev.adapter.failures.push(new ProviderError("Anthropic", 200, "Claude declined this request (cyber).", false));
    const { sink, done } = run([lead.a, dev.a]);
    expect((await done).status).toBe("completed");
    expect(dev.adapter.prompts.filter((p) => p.kind === "work")).toHaveLength(1);
    expect(sink.messages.some((m) => m.kind === "status" && /declined/.test(m.content))).toBe(true);
  });

  it("marks expired credentials without failing the rest of the team", async () => {
    const lead = agent("openai", "Lead", true);
    const dev = agent("google", "Reviewer");
    dev.adapter.failures.push(new AuthExpiredError("token revoked"));
    const { sink, done } = run([lead.a, dev.a]);
    expect((await done).status).toBe("completed");
    expect(sink.expired).toEqual(["google"]);
    expect(sink.runs.find((r) => r.error === "Authorization expired")).toBeTruthy();
  });

  it("fails cleanly when every agent fails", async () => {
    const only = agent("anthropic", "Developer", true);
    only.adapter.failures.push(new ProviderError("Anthropic", 400, "bad request"), new ProviderError("Anthropic", 400, "bad request"));
    const { done } = run([only.a]);
    expect((await done).status).toBe("failed");
  });
});
