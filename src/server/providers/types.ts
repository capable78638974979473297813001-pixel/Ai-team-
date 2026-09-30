/**
 * Provider abstraction. The orchestrator only ever talks to `ProviderAdapter`,
 * never to a vendor SDK directly, so providers can be added independently.
 */

export type ProviderId = "openai" | "anthropic" | "google" | "xai" | "cursor";

export type Capability =
  | "chat"
  | "reasoning"
  | "coding"
  | "web_research"
  | "files"
  | "images"
  | "tool_use"
  | "repository_access"
  | "subscription_delegation"
  | "streaming";

export type MethodId = "oauth" | "api_key" | "sandbox";

/**
 * - available: can be used now
 * - not_configured: officially supported, but this server lacks the OAuth client registration
 * - coming_soon: the provider has signalled support but hasn't opened it to third parties
 * - unsupported: the provider does not permit it
 */
export type MethodAvailability = "available" | "not_configured" | "coming_soon" | "unsupported";

export type ConnectionMethodInfo = {
  id: MethodId;
  label: string;
  availability: MethodAvailability;
  /** Shown when the method can't be used. */
  reason?: string;
  /** Plain-language statement of who pays. */
  billing: string;
  subscriptionDelegation: boolean;
  apiKey?: { placeholder: string; consoleUrl: string; prefix?: string };
  fields?: { name: string; label: string; placeholder?: string; optional: boolean }[];
};

export type ProviderInfo = {
  id: ProviderId;
  name: string;
  product: string;
  vendor: string;
  /** Short strength label for dashboard cards, e.g. "Reasoning". */
  strength: string;
  docsUrl: string;
  /** Default role suggestion for auto-built teams. */
  defaultRole: { title: string; instructions: string };
};

/** Decrypted credentials. Server-only; never serialised to the browser. */
export type Credentials = {
  method: MethodId;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes: string[];
  extra: Record<string, string>;
};

export type ConnectedAccount = {
  label: string | null;
  info: Record<string, unknown>;
  models: string[];
  defaultModel: string | null;
};

export type ConnectInput =
  | { method: "api_key"; apiKey: string; fields: Record<string, string> }
  | {
      method: "oauth";
      redirectUri: string;
      state: string;
      nonce: string;
      codeChallenge: string;
      fields: Record<string, string>;
    }
  | { method: "sandbox" };

export type ConnectOutcome =
  | { kind: "connected"; credentials: Credentials; account: ConnectedAccount }
  | { kind: "redirect"; url: string };

export type OAuthCallbackInput = {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  nonce: string;
  /** All callback query parameters (some providers return an issued client_id). */
  params: URLSearchParams;
  fields: Record<string, string>;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** Our own record of a conversation with a provider. Providers are treated as stateless. */
export type ProviderConversation = {
  id: string;
  provider: ProviderId;
  model: string;
  system: string;
  history: ChatMessage[];
  /** Provider-side handles (e.g. a Cursor agent id). */
  remote: Record<string, string>;
};

export type SendOptions = {
  signal?: AbortSignal;
  /** Ask the provider to use its official web search tool, if it has one. */
  webSearch?: boolean;
  maxOutputTokens?: number;
  repoUrl?: string | null;
  allowPullRequests?: boolean;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; status: "started" | "completed" | "failed"; detail?: string }
  | { type: "done"; text: string; usage: Usage; model: string; meta?: Record<string, unknown> };

export type AgentResponse = { text: string; usage: Usage; model: string; meta?: Record<string, unknown> };

export type HealthResult = { ok: boolean; expired?: boolean; detail?: string };

export interface ProviderAdapter {
  readonly info: ProviderInfo;
  /** Connection methods and whether each is usable on this server. */
  methods(): ConnectionMethodInfo[];
  capabilities(method?: MethodId): Capability[];

  connect(input: ConnectInput): Promise<ConnectOutcome>;
  completeOAuth?(input: OAuthCallbackInput): Promise<{ credentials: Credentials; account: ConnectedAccount }>;
  /** Revoke provider-side grants where the provider supports it. */
  disconnect(creds: Credentials): Promise<void>;
  /** Exchange a refresh token. Throws AuthExpiredError if the grant is gone. */
  refreshAuth(creds: Credentials): Promise<Credentials>;

  createConversation(
    creds: Credentials,
    opts: { model?: string | null; system: string },
  ): Promise<ProviderConversation>;
  sendMessage(
    creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): Promise<AgentResponse>;
  streamMessage(
    creds: Credentials,
    conversation: ProviderConversation,
    message: string,
    opts?: SendOptions,
  ): AsyncGenerator<StreamChunk>;
  cancel(creds: Credentials, conversation: ProviderConversation): Promise<void>;
  healthCheck(creds: Credentials): Promise<HealthResult>;
}

export class AuthExpiredError extends Error {
  constructor(message = "The provider authorization has expired or was revoked") {
    super(message);
  }
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number | null,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
