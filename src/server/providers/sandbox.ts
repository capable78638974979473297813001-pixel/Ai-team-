import { createHash } from "node:crypto";
import { BaseAdapter } from "./base";
import type {
  Capability,
  ConnectInput,
  ConnectOutcome,
  ConnectionMethodInfo,
  Credentials,
  HealthResult,
  ProviderAdapter,
  ProviderConversation,
  SendOptions,
  StreamChunk,
} from "./types";

/**
 * Development-only simulated agent. It follows the orchestration protocol with
 * deterministic canned output so the whole pipeline (plan → work → review →
 * disagreement → judge → synthesis) can be exercised without provider
 * credentials. Disabled in production (see env.sandboxEnabled) and always
 * labelled "Sandbox" in the UI.
 */
export const SANDBOX_MODEL = "sandbox-simulated";

export const sandboxTiming = { tokenDelayMs: 12 };

export class SandboxAdapter extends BaseAdapter {
  constructor(private readonly real: ProviderAdapter) {
    super();
  }

  get info() {
    return this.real.info;
  }

  methods(): ConnectionMethodInfo[] {
    return [];
  }

  capabilities(): Capability[] {
    return this.real.capabilities("api_key").filter((c) => c !== "subscription_delegation");
  }

  protected pickDefaultModel() {
    return SANDBOX_MODEL;
  }

  async connect(_input: ConnectInput): Promise<ConnectOutcome> {
    return {
      kind: "connected",
      credentials: { method: "sandbox", accessToken: "sandbox", scopes: [], extra: {} },
      account: { label: "Sandbox (simulated)", info: { simulated: true }, models: [SANDBOX_MODEL], defaultModel: SANDBOX_MODEL },
    };
  }

  async healthCheck(): Promise<HealthResult> {
    return { ok: true, detail: "Simulated" };
  }

  async *streamMessage(
    _creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): AsyncGenerator<StreamChunk> {
    const kind = conversation.system.match(/\[protocol:(\w+)\]/)?.[1] ?? "work";
    const name = this.real.info.name;
    if (opts?.webSearch && this.capabilities().includes("web_research")) {
      yield { type: "tool", name: "web_search", status: "started" };
      await delay(200, opts.signal);
      yield { type: "tool", name: "web_search", status: "completed", detail: "Simulated search" };
    }
    const text = respond(kind, name, conversation.system, message);
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      if (opts?.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      yield { type: "delta", text: piece };
      await delay(sandboxTiming.tokenDelayMs, opts?.signal);
    }
    conversation.history.push({ role: "user", content: message }, { role: "assistant", content: text });
    yield {
      type: "done",
      text,
      usage: { inputTokens: Math.ceil(message.length / 4), outputTokens: Math.ceil(text.length / 4) },
      model: SANDBOX_MODEL,
    };
  }
}

function delay(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });
}

function hash(s: string) {
  return createHash("sha256").update(s).digest().readUInt32BE(0);
}

function topic(message: string) {
  const task = message.match(/(?:TASK:|Overall task(?: from the user)?:|The user asked:)\s*\n?([^\n]+)/i)?.[1] ?? message;
  return task.trim().replace(/[.?!]+$/, "").slice(0, 140);
}

function respond(kind: string, name: string, system: string, message: string): string {
  const role = system.match(/the (.+?) on an AI team/)?.[1] ?? "Specialist";
  const t = topic(message);
  switch (kind) {
    case "plan": {
      const agents = [...message.matchAll(/- agent `([^`]+)` — ([^,]+), ([^;]+); capabilities: ([^;\n]+)/g)].map((m) => ({
        key: m[1]!,
        name: m[2]!,
        role: m[3]!,
        caps: m[4]!,
      }));
      const max = Number(message.match(/use at most (\d+) agents/)?.[1] ?? agents.length);
      const hasRepo = !/No repository is attached/.test(message);
      const chosen = agents.filter((a) => hasRepo || !/repository_access/.test(a.caps)).slice(0, max);
      const subtasks = chosen.map((a) => ({
        agent: a.key,
        title: `${a.role} pass`,
        instructions: `From the perspective of the ${a.role}, analyse: ${t}. Report specific, checkable findings.`,
        verify: true,
        webSearch: /web_research/.test(a.caps) && /research|current|news|market|latest/i.test(a.role + t),
      }));
      return "```json\n" + JSON.stringify({ summary: `Split "${t}" across ${chosen.length} specialists, then cross-review.`, subtasks }, null, 1) + "\n```";
    }
    case "work": {
      const seed = hash(name + message);
      const angles = [
        "the core assumptions hold, but two depend on unstated constraints",
        "error handling is the weakest area and should be addressed first",
        "the main risk is operational rather than technical",
        "test coverage for the critical path is thinner than it looks",
        "configuration is scattered and should be centralised",
        "the approach scales for now but needs a caching layer beyond roughly 10× load",
        "documentation of the security model is missing",
      ];
      const pick = (i: number) => angles[(seed + i * 3) % angles.length];
      const revising = /This is a revision/.test(message);
      return [
        `SUMMARY: As ${role}, my view on "${t}" is that ${pick(0)}.${revising ? " Revised after the judge's rulings." : ""}`,
        "FINDINGS:",
        `- [F1] ${cap(pick(0))}.`,
        `- [F2] ${cap(pick(1))}.`,
        `- [F3] ${cap(pick(2))}.`,
        "DETAILS:",
        `(Sandbox output from a simulated ${name} agent — connect a real provider for genuine analysis.)`,
      ].join("\n");
    }
    case "review": {
      const findings = [...message.matchAll(/^\[(F\d+)\]\s*(.+)$/gm)].map((m) => ({ id: m[1]!, text: m[2]! }));
      const seed = hash(name + message);
      const flagged = findings.length ? seed % findings.length : -1;
      const reviews = findings.map((f, i) => ({
        finding: f.id,
        verdict: i === flagged ? (seed % 2 ? "incorrect" : "incomplete") : "correct",
        note: i === flagged ? "This overstates the evidence; the opposite is at least as likely." : "Consistent with what I see.",
      }));
      return "```json\n" + JSON.stringify({ summary: `Mostly sound; ${flagged >= 0 ? "one point is disputed" : "nothing to dispute"}.`, reviews, missing: [] }, null, 1) + "\n```";
    }
    case "judge": {
      const ids = [...message.matchAll(/^(D\d+)\./gm)].map((m) => m[1]!);
      const round = Number(message.match(/ROUND: (\d+) of (\d+)/)?.[1] ?? 1);
      const maxRounds = Number(message.match(/ROUND: \d+ of (\d+)/)?.[1] ?? 1);
      const authors = [...message.matchAll(/, ([^,]+?) claimed \[/g)].map((m) => m[1]!);
      const keys = message.match(/\(agents: ([^)]+)\)/)?.[1]?.split(/,\s*/) ?? [];
      const rulings = ids.map((id, i) => ({
        id,
        ruling: i % 2 === 0 ? "reviewer" : "partial",
        resolution: i % 2 === 0 ? "The reviewer is right; the claim should be dropped." : "Both are partly right; keep the claim with a qualification.",
      }));
      const another = round < maxRounds && ids.length >= 2;
      const followAgent = keys.find((k) => authors.some((a) => a.toLowerCase().includes(k))) ?? keys[0];
      return "```json\n" + JSON.stringify({
        summary: `Resolved ${ids.length} disagreement${ids.length === 1 ? "" : "s"}.`,
        rulings,
        anotherRound: another,
        followUps: another && followAgent ? [{ agent: followAgent, instructions: "Revise your findings in light of the rulings." }] : [],
      }, null, 1) + "\n```";
    }
    case "synthesis": {
      const summaries = [...message.matchAll(/### (.+?) — (.+?): .+\nSummary: (.+)/g)].map((m) => `- **${m[1]}** (${m[2]}): ${m[3]}`);
      return [
        `**Answer:** The team's combined view on "${t}" is below. This was produced by simulated sandbox agents.`,
        "",
        "## What the team found",
        ...summaries,
        "",
        "## Resolved disagreements",
        /Judge's rulings/.test(message) ? "Disputed claims were dropped or qualified according to the judge's rulings." : "No material disagreements.",
        "",
        "## Open questions",
        "- Connect real providers to replace the simulated analysis.",
      ].join("\n");
    }
    case "team": {
      const purpose = message.match(/purpose:\n([^\n]+)/)?.[1] ?? "the task";
      const ids = [...message.matchAll(/^- "([a-z]+)": ([^ ]+)/gm)].map((m) => ({ id: m[1]!, name: m[2]! })).filter((p) => p.id !== "cursor");
      const roles = ["Lead", "Specialist", "Reviewer", "Researcher"];
      return JSON.stringify({
        name: `Team for ${purpose.slice(0, 40)}`,
        description: purpose,
        agents: ids.slice(0, 4).map((p, i) => ({
          provider: p.id,
          roleTitle: roles[i],
          roleInstructions: `${roles[i]} for: ${purpose}`,
          isLead: i === 0,
        })),
      });
    }
    default:
      return `SUMMARY: Simulated response from ${name}.\nFINDINGS:\n- [F1] No real provider is connected.`;
  }
}

function cap(s = "") {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
