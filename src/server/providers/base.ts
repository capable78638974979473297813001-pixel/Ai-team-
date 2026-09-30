import { randomUUID } from "node:crypto";
import type {
  AgentResponse,
  Capability,
  ConnectInput,
  ConnectOutcome,
  ConnectionMethodInfo,
  Credentials,
  HealthResult,
  MethodId,
  ProviderAdapter,
  ProviderConversation,
  ProviderInfo,
  SendOptions,
  StreamChunk,
} from "./types";

/** Shared behaviour: stateless conversations kept on our side, send = drain stream. */
export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly info: ProviderInfo;
  abstract methods(): ConnectionMethodInfo[];
  abstract capabilities(method?: MethodId): Capability[];
  abstract connect(input: ConnectInput): Promise<ConnectOutcome>;
  abstract healthCheck(creds: Credentials): Promise<HealthResult>;
  abstract streamMessage(
    creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): AsyncGenerator<StreamChunk>;

  protected abstract pickDefaultModel(models: string[]): string | null;

  async disconnect(_creds: Credentials): Promise<void> {
    // API keys are revoked in the provider's own console; nothing to call.
  }

  async refreshAuth(creds: Credentials): Promise<Credentials> {
    return creds;
  }

  async createConversation(creds: Credentials, opts: { model?: string | null; system: string }) {
    const model = opts.model || creds.extra.defaultModel || this.pickDefaultModel([]) || "";
    return {
      id: randomUUID(),
      provider: this.info.id,
      model,
      system: opts.system,
      history: [],
      remote: {},
    } satisfies ProviderConversation;
  }

  async sendMessage(
    creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): Promise<AgentResponse> {
    let final: AgentResponse | null = null;
    for await (const chunk of this.streamMessage(creds, conversation, message, opts)) {
      if (chunk.type === "done") final = { text: chunk.text, usage: chunk.usage, model: chunk.model, meta: chunk.meta };
    }
    if (!final) throw new Error(`${this.info.name} ended the response without completing`);
    return final;
  }

  async cancel(_creds: Credentials, _conversation: ProviderConversation): Promise<void> {
    // Local requests are cancelled via the AbortSignal passed to streamMessage.
  }
}

/** Rank model ids: prefer names matching `prefer` patterns, then higher version numbers. */
export function rankModels(models: string[], prefer: RegExp[], exclude: RegExp): string | null {
  const candidates = models.filter((m) => !exclude.test(m));
  if (!candidates.length) return null;
  const score = (m: string) => {
    const p = prefer.findIndex((re) => re.test(m));
    const version = (m.match(/\d+(\.\d+)?/g) ?? []).map(Number).reduce((a, b) => a * 100 + b, 0);
    return (p === -1 ? 0 : (prefer.length - p) * 1e9) + version;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
}
