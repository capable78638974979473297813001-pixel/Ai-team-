import Anthropic from "@anthropic-ai/sdk";
import { BaseAdapter, rankModels } from "./base";
import { providerFetch } from "./http";
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

export const ANTHROPIC_API = "https://api.anthropic.com";

/** Models that accept the server-side refusal fallback in its "default" form. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
/** Models that support the dynamic-filtering web search tool version. */
const WEB_SEARCH_2026 = /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5)/;

export class AnthropicProvider extends BaseAdapter {
  readonly info = {
    id: "anthropic" as const,
    name: "Claude",
    product: "Claude / Claude API",
    vendor: "Anthropic",
    strength: "Coding",
    docsUrl: "https://platform.claude.com/docs",
    defaultRole: {
      title: "Lead Developer",
      instructions: "Inspect code and details deeply. Find concrete defects, with file and line references when possible.",
    },
  };

  methods(): ConnectionMethodInfo[] {
    return [
      {
        id: "oauth",
        label: "Claude subscription (Pro / Max)",
        availability: "unsupported",
        reason:
          "Anthropic does not permit third-party apps to offer Claude.ai login or to use Free, Pro or Max plan credentials. Use a Claude Console API key instead.",
        billing: "Not available",
        subscriptionDelegation: false,
      },
      {
        id: "api_key",
        label: "Claude API key",
        availability: "available",
        billing: "Billed to your Claude Console organization, not your Claude subscription",
        subscriptionDelegation: false,
        apiKey: { placeholder: "sk-ant-…", consoleUrl: "https://platform.claude.com/settings/keys", prefix: "sk-ant-" },
      },
    ];
  }

  capabilities(): Capability[] {
    return ["chat", "reasoning", "coding", "web_research", "files", "images", "tool_use", "streaming"];
  }

  protected pickDefaultModel(models: string[]) {
    if (models.includes("claude-opus-5-5") || models.length === 0) return "claude-opus-5-5";
    return rankModels(models, [/^claude-opus-/, /^claude-sonnet-/], /haiku|mythos/);
  }

  private client(apiKey: string) {
    // Explicit baseURL/authToken so ambient ANTHROPIC_* environment variables are never picked up.
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: ANTHROPIC_API,
      fetch: (url, init) => providerFetch(url as string, init as RequestInit),
      maxRetries: 2,
      timeout: 10 * 60_000,
    });
  }

  private async listModels(apiKey: string): Promise<string[]> {
    const ids: string[] = [];
    try {
      for await (const m of this.client(apiKey).models.list({ limit: 100 })) ids.push(m.id);
    } catch (err) {
      throw mapError(err);
    }
    return ids.sort();
  }

  async connect(input: ConnectInput): Promise<ConnectOutcome> {
    if (input.method !== "api_key") {
      throw new Error("Anthropic does not allow third-party apps to use Claude subscriptions");
    }
    const models = await this.listModels(input.apiKey);
    return {
      kind: "connected",
      credentials: { method: "api_key", accessToken: input.apiKey, scopes: [], extra: {} },
      account: {
        label: "API key",
        info: { keySuffix: input.apiKey.slice(-4) },
        models,
        defaultModel: this.pickDefaultModel(models),
      },
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

  async *streamMessage(
    creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): AsyncGenerator<StreamChunk> {
    const client = this.client(creds.accessToken);
    const model = conversation.model || "claude-opus-5-5";
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...conversation.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];
    const useSearch = !!opts?.webSearch;
    const tools: Anthropic.Beta.BetaToolUnion[] | undefined = useSearch
      ? [
          WEB_SEARCH_2026.test(model)
            ? { type: "web_search_20260209", name: "web_search", max_uses: 5 }
            : { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ]
      : undefined;
    const fallback = FALLBACK_MODELS.has(model);

    const run = (withTools: boolean) =>
      client.beta.messages.stream(
        {
          model,
          max_tokens: opts?.maxOutputTokens ?? 32_000,
          system: conversation.system,
          messages,
          ...(withTools && tools ? { tools } : {}),
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: opts?.signal },
      );

    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    let servedBy = model;
    let attempt = 0;
    let withTools = useSearch;

    // pause_turn: the server paused a long server-tool turn; resend to let it continue.
    while (attempt < 4) {
      attempt++;
      let final: Anthropic.Beta.BetaMessage;
      try {
        const stream = run(withTools);
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            text += ev.delta.text;
            yield { type: "delta", text: ev.delta.text };
          } else if (ev.type === "content_block_start") {
            if (ev.content_block.type === "server_tool_use") {
              yield { type: "tool", name: ev.content_block.name, status: "started" };
            } else if (ev.content_block.type === "web_search_tool_result") {
              yield { type: "tool", name: "web_search", status: "completed" };
            }
          }
        }
        final = await stream.finalMessage();
      } catch (err) {
        if (withTools && err instanceof Anthropic.BadRequestError && attempt === 1) {
          withTools = false;
          yield { type: "tool", name: "web_search", status: "failed", detail: "Web search unavailable for this organization" };
          continue;
        }
        throw mapError(err);
      }
      usage = {
        inputTokens: usage.inputTokens + (final.usage.input_tokens ?? 0),
        outputTokens: usage.outputTokens + (final.usage.output_tokens ?? 0),
      };
      servedBy = final.model;
      if (final.stop_reason === "refusal") {
        const category = final.stop_details?.category ?? "policy";
        throw new ProviderError("Anthropic", 200, `Claude declined this request (${category}).`);
      }
      if (final.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: final.content as Anthropic.Beta.BetaContentBlockParam[] });
        continue;
      }
      break;
    }

    conversation.history.push({ role: "user", content: message }, { role: "assistant", content: text });
    yield { type: "done", text, usage, model: servedBy };
  }
}

function mapError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AuthExpiredError("Claude API key was rejected");
  }
  if (err instanceof Anthropic.RateLimitError) return new ProviderError("Anthropic", 429, "Claude API rate limit reached", true);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    return new ProviderError("Anthropic", status, `Claude API error${status ? ` ${status}` : ""}: ${err.message}`, (status ?? 0) >= 500);
  }
  if (err instanceof Error && err.name === "AbortError") return err;
  return err instanceof Error ? err : new Error(String(err));
}
