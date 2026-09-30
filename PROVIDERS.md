# Provider integration research

_Last reviewed: 2026-09-30. Re-check each provider's documentation before changing an adapter — these policies move quickly._

This document records what each AI provider **officially** allows a third-party web application to do on a user's behalf, and the connection methods the platform implements as a result. The rules the platform follows are simple:

- We never ask for a provider password, and never collect browser cookies, consumer session tokens, or any other authentication state from a provider's consumer website.
- We never automate a consumer website as a substitute for an API.
- If a provider doesn't officially let third-party apps use a user's subscription, the adapter and UI still exist, but that method is shown as **Unsupported** or **Coming soon**. We don't fake it.
- A "Bring your own API key" connection uses a credential the provider issues to developers, created in the provider's own console. It is billed to the key owner under their own agreement with the provider. It is **not** subscription delegation, and the UI says so.

## Summary

| Provider | Subscription delegation via OAuth | Official API credential | What we implement |
|---|---|---|---|
| OpenAI / ChatGPT | **Sign in with ChatGPT** (OAuth 2.0 + OIDC + PKCE). Plan usage is open to open-source and locally-run apps and selected private apps. Hosted commercial apps need OpenAI approval (interest form / waitlist). | OpenAI Platform API key | SIWC adapter (turned off by default; turned on once `OPENAI_SIWC_CLIENT_ID` is configured), plus API key |
| Anthropic / Claude | **Not permitted.** Anthropic doesn't allow third-party developers to offer Claude.ai login or to route requests through Free/Pro/Max plan credentials. | Claude Console API key | API key. Subscription method shown as **Unsupported** |
| Google / Gemini | Google OAuth 2.0 (Authorization Code + PKCE) is officially supported for the Gemini API. Usage is billed to a Google Cloud project (the quota project), **not** to the user's Google AI consumer plan. | Gemini API key (AI Studio) | Google OAuth (real, works end to end when `GOOGLE_CLIENT_ID`/`SECRET` are configured), plus API key. Subscription delegation marked **false** |
| xAI / Grok | xAI runs a SuperGrok/X Premium OAuth flow for a few named partner tools, but we found **no public developer documentation** for third-party client registration. | xAI Console API key | API key. Subscription OAuth shown as **Coming soon** |
| Cursor | No OAuth for third parties. | User or service-account API key from the Cursor Dashboard (Cloud Agents API) | API key. Cloud Agents API for repository coding work |

## OpenAI / ChatGPT

**Sources:** [Sign in with ChatGPT](https://developers.openai.com/siwc), [Quickstart](https://developers.openai.com/siwc/quickstart), [On your website](https://developers.openai.com/siwc/website), [ChatGPT plan usage in open-source apps](https://developers.openai.com/siwc/token-sharing-open-source), [Cookbook: Integrating SIWC](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [Help: Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).

- **Protocol:** OAuth 2.0 Authorization Code with PKCE (S256), plus OpenID Connect. A fresh `state`, `nonce` and PKCE verifier are required for every transaction.
- **Discovery:** `https://auth.openai.com/.well-known/openid-configuration`
  - Issuer: `https://auth.openai.com`
  - Authorize: `https://auth.openai.com/api/accounts/authorize`
  - Token: `https://auth.openai.com/api/accounts/oauth/token`
  - JWKS: `https://auth.openai.com/.well-known/jwks.json`
- **Scopes:** identity uses `openid profile email`. Plan usage adds `offline_access` (refresh token) and the Responses API invocation grant (`resource.invoke`, `chatgpt.tokens.use.direct`) with `resource=https://api.openai.com/v1`. The exact scope list is configurable through `OPENAI_SIWC_SCOPES`, because OpenAI issues the final values at client registration.
- **Clients:** open-source apps use a dynamic client (`client_id=dynamic_agent_client`) and a persisted `ext_agent_host_id`. The issued `client_id` comes back on the redirect. Registered website clients get an `oaiapp_*` client ID and an exact callback URL.
- **Inference:** Responses API (`POST https://api.openai.com/v1/responses`) with the OAuth access token as a Bearer token, `store: false`, `stream: true`.
- **What it does *not* grant:** chat history, memories, files, and billing data are not shared. **We don't import ChatGPT history over OAuth.**
- **Availability constraint:** a hosted multi-user deployment of this platform must be approved by OpenAI before offering plan usage. Until `OPENAI_SIWC_CLIENT_ID` is set, the connection shows as **Coming soon**.
- **API key:** Platform API keys work with the same Responses API and are billed to the key's organization.

## Anthropic / Claude

**Sources:** [Claude Code: Legal and compliance → Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance), [Claude API docs](https://platform.claude.com/docs).

- Anthropic states: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
- Developers building products "should use API key authentication through Claude Console or a supported cloud provider". Usage must be billed to the key owner.
- **Implementation:** the user pastes an API key they created in the Claude Console. It's validated with `GET /v1/models` and encrypted at rest. Inference uses the Messages API (`POST https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`, SSE streaming). The "Claude subscription" method is displayed as **Unsupported**, with the reason.

## Google / Gemini

**Sources:** [Gemini API: Authentication with OAuth](https://ai.google.dev/gemini-api/docs/oauth), [Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key), [Google OAuth 2.0 for web server apps](https://developers.google.com/identity/protocols/oauth2/web-server).

- **Protocol:** Google OAuth 2.0 Authorization Code (web server flow) with PKCE and `access_type=offline` for a refresh token.
  - Authorize: `https://accounts.google.com/o/oauth2/v2/auth`
  - Token: `https://oauth2.googleapis.com/token`
  - Revoke: `https://oauth2.googleapis.com/revoke`
  - UserInfo: `https://openidconnect.googleapis.com/v1/userinfo`
- **Scopes (least privilege):** `openid email` plus `https://www.googleapis.com/auth/generative-language.retriever` (configurable through `GOOGLE_GEMINI_SCOPES`). The Gemini API also accepts `https://www.googleapis.com/auth/cloud-platform`, but that scope is broader than we need, so it isn't the default. Restricted and sensitive scopes need Google app verification before public launch.
- **Inference:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` with `Authorization: Bearer <token>` and `x-goog-user-project: <quota project>`.
- **Billing:** OAuth usage is charged to the quota project, **not** to the user's consumer Google AI plan, so `subscriptionDelegation` is `false`. The user may enter their own Cloud project ID as the quota project (they need `serviceusage.services.use` on it).
- **API key:** AI Studio keys are sent in the `x-goog-api-key` header.

## xAI / Grok

**Sources:** [xAI API reference](https://docs.x.ai/docs/api-reference), [Grok overview](https://docs.x.ai/grok/overview), [Grok Bot](https://docs.x.ai/grok-bot/overview).

- **API:** `https://api.x.ai/v1`, Bearer API key from the xAI Console, `POST /v1/responses` (SSE with `stream: true`), and server-side tools including web search.
- **Subscription OAuth:** xAI runs an OAuth flow at `accounts.x.ai` / `auth.x.ai` that SuperGrok subscribers use in some partner tools (for example Hermes Agent and OpenCode), but xAI has published **no developer documentation for third-party client registration**. The adapter declares the method, and the UI shows it as **Coming soon**. We won't reuse another tool's client ID.
- **UX reference:** the post-connection experience (a conversation where named AI teammates post updates, hand off to one another, and work in a shared thread) follows the model of xAI's Grok Bot.

## Cursor

**Sources:** [Cursor APIs overview](https://cursor.com/docs/api), [Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints).

- **Auth:** API key from Cursor Dashboard → API Keys, or a team service-account key, sent as `Authorization: Bearer <key>` (or Basic). No OAuth for third parties.
- **API:** `https://api.cursor.com`. `GET /v1/me` identifies the key. `GET /v1/models` and `GET /v1/repositories` handle discovery. `POST /v1/agents` creates an agent and its first run. `GET /v1/agents/{id}/runs/{runId}` returns status and `result`, and `/stream` gives SSE. `POST /v1/agents/{id}/runs/{runId}/cancel` stops a run.
- **Usage** is billed to the Cursor account that owns the key.
- **Implementation:** Cursor is a coding agent. The orchestrator only assigns it work when the task references a GitHub repository the key can access. `autoCreatePR` is always `false` unless the user explicitly opts in on the task.

## Adding a provider

1. Research the provider's current official auth model and add a section here.
2. Implement `ProviderAdapter` in `src/server/providers/<id>.ts`, declaring only the capabilities the provider actually exposes.
3. Register it in `src/server/providers/registry.ts`.
4. Add adapter tests with a mocked `fetch`.
