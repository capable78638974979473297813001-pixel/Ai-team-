import { BaseAdapter } from "./base";
import { fetchJson, providerFetch, toProviderError, withTimeout } from "./http";
import {
  AuthExpiredError,
  ProviderError,
  type Capability,
  type ConnectInput,
  type ConnectOutcome,
  type ConnectionMethodInfo,
  type Credentials,
  type HealthResult,
  type ProviderConversation,
  type SendOptions,
  type StreamChunk,
} from "./types";

export const CURSOR_API = "https://api.cursor.com";
const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

/** Time between polls of a Cloud Agent run. Tests shorten it. */
export const cursorTiming = { pollMs: 5_000, maxWaitMs: 30 * 60_000 };

type AgentObject = { id: string; latestRunId?: string };
type CreateAgentResponse = AgentObject & { agent?: AgentObject; run?: { id: string } };
type FollowUpResponse = { id?: string; run?: { id: string } };
type ModelsResponse = (string | { id?: string })[] | { models?: (string | { id?: string })[]; data?: (string | { id?: string })[] };

type Run = {
  id: string;
  status: string;
  result?: string;
  durationMs?: number;
  git?: { branches?: { repoUrl?: string; branch?: string; prUrl?: string }[] };
};

export class CursorProvider extends BaseAdapter {
  readonly info = {
    id: "cursor" as const,
    name: "Cursor",
    product: "Cursor Cloud Agents",
    vendor: "Anysphere",
    strength: "Code changes",
    docsUrl: "https://cursor.com/docs/cloud-agent/api/endpoints",
    defaultRole: {
      title: "Coding Agent",
      instructions: "Make the requested code changes in the repository on a branch. Summarise what changed and why.",
    },
  };

  methods(): ConnectionMethodInfo[] {
    return [
      {
        id: "oauth",
        label: "Sign in with Cursor",
        availability: "unsupported",
        reason: "Cursor does not offer OAuth for third-party apps. Create an API key in the Cursor Dashboard.",
        billing: "Not available",
        subscriptionDelegation: false,
      },
      {
        id: "api_key",
        label: "Cursor API key",
        availability: "available",
        billing: "Cloud Agent usage is billed to the Cursor account that owns the key",
        subscriptionDelegation: false,
        apiKey: { placeholder: "crsr_…", consoleUrl: "https://cursor.com/dashboard?tab=integrations", prefix: "crsr_" },
      },
    ];
  }

  capabilities(): Capability[] {
    // Cursor is a repository coding agent, not a general chat model.
    return ["coding", "repository_access", "tool_use", "files"];
  }

  protected pickDefaultModel(models: string[]) {
    return models[0] ?? null;
  }

  private headers(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async connect(input: ConnectInput): Promise<ConnectOutcome> {
    if (input.method !== "api_key") throw new Error("Cursor only supports API keys");
    const me = await fetchJson<Record<string, unknown>>("Cursor", `${CURSOR_API}/v1/me`, {
      headers: this.headers(input.apiKey),
      timeoutMs: 15_000,
    });
    let models: string[] = [];
    try {
      const body = await fetchJson<ModelsResponse>("Cursor", `${CURSOR_API}/v1/models`, { headers: this.headers(input.apiKey), timeoutMs: 15_000 });
      const list = Array.isArray(body) ? body : (body.models ?? body.data ?? []);
      models = list.map((m) => (typeof m === "string" ? m : m.id)).filter((m): m is string => !!m);
    } catch {
      /* optional */
    }
    const label = (me.userEmail as string) ?? (me.apiKeyName as string) ?? "API key";
    return {
      kind: "connected",
      credentials: { method: "api_key", accessToken: input.apiKey, scopes: [], extra: {} },
      account: {
        label,
        // Only non-secret, officially returned fields.
        info: { email: me.userEmail ?? null, keyName: me.apiKeyName ?? null, keySuffix: input.apiKey.slice(-4) },
        models,
        defaultModel: null,
      },
    };
  }

  async healthCheck(creds: Credentials): Promise<HealthResult> {
    try {
      await fetchJson("Cursor", `${CURSOR_API}/v1/me`, { headers: this.headers(creds.accessToken), timeoutMs: 10_000 });
      return { ok: true };
    } catch (err) {
      if (err instanceof AuthExpiredError) return { ok: false, expired: true, detail: err.message };
      return { ok: false, detail: (err as Error).message };
    }
  }

  async *streamMessage(
    creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): AsyncGenerator<StreamChunk> {
    if (!opts?.repoUrl) {
      throw new ProviderError("Cursor", null, "Cursor needs a GitHub repository URL on the task to work on.");
    }
    const prompt = `${conversation.system}\n\n${message}`;
    let agentId = conversation.remote.agentId;
    let runId: string | undefined;

    if (!agentId) {
      const body = await fetchJson<CreateAgentResponse>("Cursor", `${CURSOR_API}/v1/agents`, {
        method: "POST",
        headers: this.headers(creds.accessToken),
        signal: opts.signal,
        body: JSON.stringify({
          prompt: { text: prompt },
          ...(conversation.model ? { model: { id: conversation.model } } : {}),
          name: "AI Team task",
          repos: [{ url: opts.repoUrl }],
          // Never open pull requests unless the user explicitly opted in on this task.
          autoCreatePR: !!opts.allowPullRequests,
        }),
      });
      const agent = body.agent ?? body;
      agentId = agent.id;
      runId = body.run?.id ?? agent.latestRunId;
      conversation.remote.agentId = agentId;
    } else {
      const body = await fetchJson<FollowUpResponse>("Cursor", `${CURSOR_API}/v1/agents/${agentId}/runs`, {
        method: "POST",
        headers: this.headers(creds.accessToken),
        signal: opts.signal,
        body: JSON.stringify({ prompt: { text: message } }),
      });
      runId = body.run?.id ?? body.id;
    }
    if (!agentId || !runId) throw new ProviderError("Cursor", null, "Cursor did not return an agent run");
    conversation.remote.runId = runId;
    yield { type: "tool", name: "cursor_cloud_agent", status: "started", detail: `Agent ${agentId}` };

    const started = Date.now();
    let run: Run;
    while (true) {
      if (opts.signal?.aborted) {
        await this.cancel(creds, conversation);
        throw new DOMException("Cancelled", "AbortError");
      }
      const res = await providerFetch(`${CURSOR_API}/v1/agents/${agentId}/runs/${runId}`, {
        headers: this.headers(creds.accessToken),
        signal: withTimeout(opts.signal, 20_000),
      });
      if (!res.ok) throw await toProviderError("Cursor", res);
      run = (await res.json()) as Run;
      if (TERMINAL.has(run.status)) break;
      if (Date.now() - started > cursorTiming.maxWaitMs) {
        await this.cancel(creds, conversation);
        throw new ProviderError("Cursor", null, "Cursor agent run exceeded the time limit");
      }
      await sleep(cursorTiming.pollMs, opts.signal);
    }

    if (run.status !== "FINISHED") {
      yield { type: "tool", name: "cursor_cloud_agent", status: "failed", detail: run.status };
      throw new ProviderError("Cursor", null, `Cursor agent run ended with status ${run.status}`);
    }
    const branches = (run.git?.branches ?? [])
      .map((b) => `- ${b.branch ?? "branch"}${b.prUrl ? ` (PR: ${b.prUrl})` : ""}`)
      .join("\n");
    const text = [run.result ?? "", branches ? `\n\nBranches:\n${branches}` : ""].join("");
    yield { type: "tool", name: "cursor_cloud_agent", status: "completed", detail: branches ? "Changes pushed to a branch" : undefined };
    yield { type: "delta", text };
    conversation.history.push({ role: "user", content: message }, { role: "assistant", content: text });
    yield { type: "done", text, usage: { inputTokens: 0, outputTokens: 0 }, model: conversation.model || "cursor", meta: { agentId, runId } };
  }

  async cancel(creds: Credentials, conversation: ProviderConversation): Promise<void> {
    const { agentId, runId } = conversation.remote;
    if (!agentId || !runId) return;
    try {
      await providerFetch(`${CURSOR_API}/v1/agents/${agentId}/runs/${runId}/cancel`, {
        method: "POST",
        headers: this.headers(creds.accessToken),
        signal: withTimeout(undefined, 10_000),
      });
    } catch {
      /* best effort */
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
