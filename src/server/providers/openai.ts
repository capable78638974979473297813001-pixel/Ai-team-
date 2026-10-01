import { createHash } from "node:crypto";
import { appOrigin, env } from "../env";
import { BaseAdapter, rankModels } from "./base";
import { fetchJson, formBody, providerFetch, toProviderError } from "./http";
import { verifyIdToken } from "./oidc";
import { streamResponses } from "./responses-api";
import {
  AuthExpiredError,
  type Capability,
  type ConnectInput,
  type ConnectOutcome,
  type ConnectedAccount,
  type ConnectionMethodInfo,
  type Credentials,
  type HealthResult,
  type MethodId,
  type OAuthCallbackInput,
  type ProviderConversation,
  type SendOptions,
  type StreamChunk,
} from "./types";

export const OPENAI_API = "https://api.openai.com/v1";
export const OPENAI_AUTH = {
  issuer: "https://auth.openai.com",
  discovery: "https://auth.openai.com/.well-known/openid-configuration",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  /** Dynamic client used by open-source apps (see PROVIDERS.md). */
  dynamicClientId: "dynamic_agent_client",
};

/**
 * Sign in with ChatGPT requires a persisted `ext_agent_host_id` for the
 * environment the agent runs in. A hosted deployment is one host, so unless one
 * is configured we derive a stable `urn:uuid:` (UUIDv4 layout) from APP_URL.
 */
export function agentHostId() {
  const configured = env().OPENAI_SIWC_HOST_ID;
  if (configured) return configured;
  const h = createHash("sha256").update(`aiteam-host:${appOrigin()}`).digest("hex").split("");
  h[12] = "4";
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const x = h.join("");
  return `urn:uuid:${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export class OpenAIProvider extends BaseAdapter {
  readonly info = {
    id: "openai" as const,
    name: "ChatGPT",
    product: "ChatGPT / OpenAI API",
    vendor: "OpenAI",
    strength: "Reasoning",
    docsUrl: "https://developers.openai.com/siwc",
    defaultRole: {
      title: "Architect",
      instructions: "Reason about structure, trade-offs and overall design. Be decisive and concrete.",
    },
  };

  methods(): ConnectionMethodInfo[] {
    const siwcConfigured = !!env().OPENAI_SIWC_CLIENT_ID;
    return [
      {
        id: "oauth",
        label: "Sign in with ChatGPT",
        availability: siwcConfigured ? "available" : "coming_soon",
        reason: siwcConfigured
          ? undefined
          : "OpenAI currently offers ChatGPT plan usage to open-source/local apps and selected partners. This deployment is awaiting OpenAI approval.",
        billing: "Uses your ChatGPT plan allowance for eligible requests",
        subscriptionDelegation: true,
      },
      {
        id: "api_key",
        label: "OpenAI API key",
        availability: "available",
        billing: "Billed to your OpenAI Platform account, not your ChatGPT subscription",
        subscriptionDelegation: false,
        apiKey: { placeholder: "sk-…", consoleUrl: "https://platform.openai.com/api-keys", prefix: "sk-" },
      },
    ];
  }

  capabilities(method?: MethodId): Capability[] {
    const base: Capability[] = ["chat", "reasoning", "coding", "web_research", "files", "images", "tool_use", "streaming"];
    return method === "oauth" ? [...base, "subscription_delegation"] : base;
  }

  protected pickDefaultModel(models: string[]) {
    return rankModels(
      models,
      [/^gpt-\d+(\.\d+)?$/, /^gpt-\d/, /^o\d/],
      /mini|nano|audio|realtime|image|tts|transcribe|search|embedding|moderation|dall|whisper|instruct|babbage|davinci|codex|sora|preview/i,
    );
  }

  async listModels(creds: Credentials) {
    return this.listModelIds(creds.accessToken);
  }

  private async listModelIds(token: string): Promise<string[]> {
    const body = await fetchJson<{ data: { id: string }[] }>("OpenAI", `${OPENAI_API}/models`, {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
    });
    return body.data.map((m) => m.id).filter((id) => /^(gpt-|o\d)/.test(id)).sort();
  }

  async connect(input: ConnectInput): Promise<ConnectOutcome> {
    if (input.method === "api_key") {
      const models = await this.listModelIds(input.apiKey);
      return {
        kind: "connected",
        credentials: { method: "api_key", accessToken: input.apiKey, scopes: [], extra: {} },
        account: { label: "API key", info: { keySuffix: input.apiKey.slice(-4) }, models, defaultModel: this.pickDefaultModel(models) },
      };
    }
    if (input.method === "oauth") {
      const e = env();
      if (!e.OPENAI_SIWC_CLIENT_ID) throw new Error("Sign in with ChatGPT is not available on this server");
      const url = new URL(OPENAI_AUTH.authorize);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: e.OPENAI_SIWC_CLIENT_ID,
        redirect_uri: input.redirectUri,
        scope: e.OPENAI_SIWC_SCOPES,
        state: input.state,
        nonce: input.nonce,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
        resource: OPENAI_API,
        agent_name_hint: "AI Team",
        ext_agent_host_id: agentHostId(),
      }).toString();
      return { kind: "redirect", url: url.toString() };
    }
    throw new Error("Unsupported connection method");
  }

  async completeOAuth(input: OAuthCallbackInput): Promise<{ credentials: Credentials; account: ConnectedAccount }> {
    const e = env();
    // The dynamic client flow returns the issued client_id on the redirect.
    const issued = input.params.get("client_id");
    const clientId = issued && e.OPENAI_SIWC_CLIENT_ID === OPENAI_AUTH.dynamicClientId ? issued : e.OPENAI_SIWC_CLIENT_ID!;
    const tokens = await this.tokenRequest(
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
        client_id: clientId,
        resource: OPENAI_API,
      },
    );
    if (!tokens.id_token) throw new Error("OpenAI did not return an ID token");
    const claims = await verifyIdToken(tokens.id_token, {
      issuer: OPENAI_AUTH.issuer,
      audience: clientId,
      nonce: input.nonce,
      jwksUri: OPENAI_AUTH.jwks,
    });
    const scopes = (tokens.scope ?? e.OPENAI_SIWC_SCOPES).split(/\s+/).filter(Boolean);
    const authClaim = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    let models: string[] = [];
    try {
      models = await this.listModelIds(tokens.access_token);
    } catch {
      /* model discovery is optional for plan tokens */
    }
    return {
      credentials: {
        method: "oauth",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        scopes,
        extra: { clientId },
      },
      account: {
        label: claims.email ?? claims.name ?? "ChatGPT account",
        info: {
          email: claims.email,
          name: claims.name,
          ...(typeof authClaim.chatgpt_plan_type === "string" ? { plan: authClaim.chatgpt_plan_type } : {}),
        },
        models,
        defaultModel: this.pickDefaultModel(models),
      },
    };
  }

  private async tokenRequest(params: Record<string, string>) {
    const e = env();
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (e.OPENAI_SIWC_CLIENT_SECRET) {
      headers.authorization = `Basic ${Buffer.from(`${params.client_id}:${e.OPENAI_SIWC_CLIENT_SECRET}`).toString("base64")}`;
    }
    const res = await providerFetch(OPENAI_AUTH.token, { method: "POST", headers, body: formBody(params) });
    if (!res.ok) {
      const err = await toProviderError("OpenAI", res);
      if (res.status === 400 || res.status === 401) throw new AuthExpiredError(err.message);
      throw err;
    }
    return (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
    };
  }

  async refreshAuth(creds: Credentials): Promise<Credentials> {
    if (creds.method !== "oauth") return creds;
    if (!creds.refreshToken) throw new AuthExpiredError();
    const tokens = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: creds.extra.clientId ?? env().OPENAI_SIWC_CLIENT_ID ?? "",
      resource: OPENAI_API,
    });
    return {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? creds.refreshToken,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
    };
  }

  async disconnect(creds: Credentials): Promise<void> {
    if (creds.method !== "oauth") return;
    try {
      const disc = await fetchJson<{ revocation_endpoint?: string }>("OpenAI", OPENAI_AUTH.discovery, { timeoutMs: 10_000 });
      if (!disc.revocation_endpoint) return;
      await providerFetch(disc.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({ token: creds.refreshToken ?? creds.accessToken, client_id: creds.extra.clientId }),
      });
    } catch {
      // Local deletion still happens; the user can also revoke from ChatGPT settings.
    }
  }

  async healthCheck(creds: Credentials): Promise<HealthResult> {
    try {
      await this.listModelIds(creds.accessToken);
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
      provider: "OpenAI",
      baseUrl: OPENAI_API,
      token: creds.accessToken,
      conversation,
      message,
      opts,
      webSearchTool: { type: "web_search" },
      store: false,
    });
  }
}
