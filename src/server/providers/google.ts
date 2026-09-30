import { env } from "../env";
import { BaseAdapter, rankModels } from "./base";
import { fetchJson, formBody, parseSSE, providerFetch, toProviderError, withTimeout } from "./http";
import { verifyIdToken } from "./oidc";
import {
  AuthExpiredError,
  ProviderError,
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

export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
export const GOOGLE_AUTH = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};

export class GoogleProvider extends BaseAdapter {
  readonly info = {
    id: "google" as const,
    name: "Gemini",
    product: "Gemini API",
    vendor: "Google",
    strength: "Research",
    docsUrl: "https://ai.google.dev/gemini-api/docs/oauth",
    defaultRole: {
      title: "Reviewer",
      instructions: "Act as an independent reviewer and judge. Weigh evidence, resolve disagreements, and say what is still unknown.",
    },
  };

  methods(): ConnectionMethodInfo[] {
    const e = env();
    const configured = !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
    return [
      {
        id: "oauth",
        label: "Sign in with Google",
        availability: configured ? "available" : "not_configured",
        reason: configured ? undefined : "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server to enable Google sign-in.",
        billing:
          "Gemini API usage is billed to a Google Cloud project (quota project), not to a Google AI consumer plan",
        subscriptionDelegation: false,
        fields: [
          {
            name: "quotaProject",
            label: "Google Cloud project ID",
            placeholder: e.GOOGLE_QUOTA_PROJECT ?? "my-project-id",
            optional: !!e.GOOGLE_QUOTA_PROJECT,
          },
        ],
      },
      {
        id: "api_key",
        label: "Gemini API key",
        availability: "available",
        billing: "Billed to the Google Cloud project behind the key",
        subscriptionDelegation: false,
        apiKey: { placeholder: "AIza…", consoleUrl: "https://aistudio.google.com/app/apikey", prefix: "AIza" },
      },
    ];
  }

  capabilities(_method?: MethodId): Capability[] {
    return ["chat", "reasoning", "coding", "web_research", "files", "images", "tool_use", "streaming"];
  }

  protected pickDefaultModel(models: string[]) {
    return rankModels(models, [/^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-pro/, /^gemini-/], /flash-lite|embedding|aqa|image|tts|live|nano|gemma|learnlm|imagen|veo/i);
  }

  private authHeaders(creds: Pick<Credentials, "method" | "accessToken" | "extra">): Record<string, string> {
    if (creds.method === "api_key") return { "x-goog-api-key": creds.accessToken };
    const project = creds.extra.quotaProject || env().GOOGLE_QUOTA_PROJECT;
    return {
      authorization: `Bearer ${creds.accessToken}`,
      ...(project ? { "x-goog-user-project": project } : {}),
    };
  }

  private async listModels(creds: Pick<Credentials, "method" | "accessToken" | "extra">): Promise<string[]> {
    const body = await fetchJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>(
      "Gemini",
      `${GEMINI_API}/models?pageSize=200`,
      { headers: this.authHeaders(creds), timeoutMs: 15_000 },
    );
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .sort();
  }

  async connect(input: ConnectInput): Promise<ConnectOutcome> {
    if (input.method === "api_key") {
      const creds = { method: "api_key" as const, accessToken: input.apiKey, extra: {} };
      const models = await this.listModels(creds);
      return {
        kind: "connected",
        credentials: { ...creds, scopes: [] },
        account: { label: "API key", info: { keySuffix: input.apiKey.slice(-4) }, models, defaultModel: this.pickDefaultModel(models) },
      };
    }
    if (input.method === "oauth") {
      const e = env();
      if (!e.GOOGLE_CLIENT_ID) throw new Error("Google sign-in is not configured on this server");
      const url = new URL(GOOGLE_AUTH.authorize);
      url.search = new URLSearchParams({
        client_id: e.GOOGLE_CLIENT_ID,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: e.GOOGLE_GEMINI_SCOPES,
        state: input.state,
        nonce: input.nonce,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent",
      }).toString();
      return { kind: "redirect", url: url.toString() };
    }
    throw new Error("Unsupported connection method");
  }

  private async tokenRequest(params: Record<string, string>) {
    const e = env();
    const res = await providerFetch(GOOGLE_AUTH.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ ...params, client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET }),
      signal: withTimeout(undefined, 15_000),
    });
    if (!res.ok) {
      const err = await toProviderError("Google", res);
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

  async completeOAuth(input: OAuthCallbackInput): Promise<{ credentials: Credentials; account: ConnectedAccount }> {
    const e = env();
    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    const claims = await verifyIdToken(tokens.id_token, {
      issuer: GOOGLE_AUTH.issuers,
      audience: e.GOOGLE_CLIENT_ID!,
      nonce: input.nonce,
      jwksUri: GOOGLE_AUTH.jwks,
    });
    const quotaProject = input.fields.quotaProject || e.GOOGLE_QUOTA_PROJECT || "";
    const credentials: Credentials = {
      method: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
      extra: quotaProject ? { quotaProject } : {},
    };
    let models: string[] = [];
    try {
      models = await this.listModels(credentials);
    } catch {
      /* the quota project may not have the API enabled yet; surfaced by health checks */
    }
    return {
      credentials,
      account: {
        label: claims.email ?? "Google account",
        info: { email: claims.email, quotaProject: quotaProject || null },
        models,
        defaultModel: this.pickDefaultModel(models),
      },
    };
  }

  async refreshAuth(creds: Credentials): Promise<Credentials> {
    if (creds.method !== "oauth") return creds;
    if (!creds.refreshToken) throw new AuthExpiredError();
    const tokens = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: creds.refreshToken });
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
      await providerFetch(GOOGLE_AUTH.revoke, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({ token: creds.refreshToken ?? creds.accessToken }),
        signal: withTimeout(undefined, 10_000),
      });
    } catch {
      // Best effort; the user can also remove access at myaccount.google.com/permissions.
    }
  }

  async healthCheck(creds: Credentials): Promise<HealthResult> {
    try {
      await this.listModels(creds);
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
    const model = conversation.model;
    if (!model) throw new ProviderError("Gemini", null, "No Gemini model selected for this connection");
    const contents = [...conversation.history, { role: "user" as const, content: message }].map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: conversation.system }] },
      contents,
      generationConfig: opts?.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {},
    };
    if (opts?.webSearch) body.tools = [{ google_search: {} }];

    const send = () =>
      providerFetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders(creds) },
        body: JSON.stringify(body),
        signal: withTimeout(opts?.signal, 10 * 60_000),
      });

    let res = await send();
    if (res.status === 400 && body.tools) {
      delete body.tools;
      yield { type: "tool", name: "google_search", status: "failed", detail: "Search grounding unavailable" };
      res = await send();
    }
    if (!res.ok) throw await toProviderError("Gemini", res);
    if (opts?.webSearch && body.tools) yield { type: "tool", name: "google_search", status: "started" };

    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    let served = model;
    let grounded = false;
    for await (const ev of parseSSE(res.body)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (data.error) throw new ProviderError("Gemini", data.error.code ?? null, `Gemini: ${data.error.message}`);
      const cand = data.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (typeof part.text === "string" && !part.thought) {
          text += part.text;
          yield { type: "delta", text: part.text };
        }
      }
      if (cand?.groundingMetadata) grounded = true;
      if (cand?.finishReason === "SAFETY" || cand?.finishReason === "PROHIBITED_CONTENT") {
        throw new ProviderError("Gemini", 200, "Gemini declined this request (safety).");
      }
      if (data.usageMetadata) {
        usage = {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
      if (data.modelVersion) served = data.modelVersion;
    }
    if (opts?.webSearch && body.tools) {
      yield { type: "tool", name: "google_search", status: "completed", detail: grounded ? "Grounded with Google Search" : undefined };
    }
    conversation.history.push({ role: "user", content: message }, { role: "assistant", content: text });
    yield { type: "done", text, usage, model: served };
  }
}
