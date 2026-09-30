import { BaseAdapter, rankModels } from "./base";
import { fetchJson } from "./http";
import { streamResponses } from "./responses-api";
import {
  AuthExpiredError,
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

export const XAI_API = "https://api.x.ai/v1";

export class XAIProvider extends BaseAdapter {
  readonly info = {
    id: "xai" as const,
    name: "Grok",
    product: "Grok / xAI API",
    vendor: "xAI",
    strength: "Current events",
    docsUrl: "https://docs.x.ai/docs/api-reference",
    defaultRole: {
      title: "Researcher",
      instructions: "Find current, verifiable information on the web. Cite sources and flag anything uncertain.",
    },
  };

  methods(): ConnectionMethodInfo[] {
    return [
      {
        id: "oauth",
        label: "Sign in with SuperGrok",
        availability: "coming_soon",
        reason:
          "xAI has not published third-party OAuth client registration for SuperGrok subscriptions. We will enable it once xAI documents it.",
        billing: "Would use your SuperGrok allowance",
        subscriptionDelegation: true,
      },
      {
        id: "api_key",
        label: "xAI API key",
        availability: "available",
        billing: "Billed to your xAI Console team, not your SuperGrok subscription",
        subscriptionDelegation: false,
        apiKey: { placeholder: "xai-…", consoleUrl: "https://console.x.ai", prefix: "xai-" },
      },
    ];
  }

  capabilities(): Capability[] {
    return ["chat", "reasoning", "coding", "web_research", "images", "tool_use", "streaming"];
  }

  protected pickDefaultModel(models: string[]) {
    return rankModels(models, [/^grok-\d+(\.\d+)?$/, /^grok-\d/], /image|vision|imagine|mini|embed|fast/i);
  }

  private async listModels(token: string) {
    const body = await fetchJson<{ data: { id: string }[] }>("xAI", `${XAI_API}/models`, {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
    });
    return body.data.map((m) => m.id).sort();
  }

  async connect(input: ConnectInput): Promise<ConnectOutcome> {
    if (input.method !== "api_key") throw new Error("xAI subscription sign-in is not available yet");
    const models = await this.listModels(input.apiKey);
    let info: Record<string, unknown> = { keySuffix: input.apiKey.slice(-4) };
    try {
      const key = await fetchJson<{ name?: string; team_id?: string }>("xAI", `${XAI_API}/api-key`, {
        headers: { authorization: `Bearer ${input.apiKey}` },
        timeoutMs: 10_000,
      });
      info = { ...info, keyName: key.name, teamId: key.team_id };
    } catch {
      /* optional metadata */
    }
    return {
      kind: "connected",
      credentials: { method: "api_key", accessToken: input.apiKey, scopes: [], extra: {} },
      account: { label: (info.keyName as string) ?? "API key", info, models, defaultModel: this.pickDefaultModel(models) },
    };
  }

  async healthCheck(creds: Credentials): Promise<HealthResult> {
    try {
      await this.listModels(creds.accessToken);
      return { ok: true };
    } catch (err) {
      if (err instanceof AuthExpiredError) return { ok: false, expired: true, detail: err.message };
      return { ok: false, detail: (err as Error).message };
    }
  }

  streamMessage(
    creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): AsyncGenerator<StreamChunk> {
    return streamResponses({
      provider: "xAI",
      baseUrl: XAI_API,
      token: creds.accessToken,
      conversation,
      message,
      opts,
      webSearchTool: { type: "web_search" },
      store: false,
    });
  }
}
