# Security

This document describes how AI Team authenticates users, how it connects to AI providers on their behalf, and how it protects the credentials involved. For what each provider officially allows, see [PROVIDERS.md](./PROVIDERS.md).

To report a vulnerability, email the maintainers privately. Don't open a public issue.

## Principles

1. **Never touch provider passwords or consumer sessions.** We don't ask for provider passwords, scrape cookies or session tokens, or automate consumer websites. Provider sign-in always completes on the provider's own domain.
2. **Only officially supported methods.** A provider's OAuth is only used where the provider permits third-party apps to use it. Anthropic's consumer-plan OAuth is refused in code (`availability: "unsupported"`). xAI's subscription OAuth stays "coming soon" until xAI documents third-party client registration.
3. **Tokens stay on the server.** Provider access and refresh tokens are decrypted only inside the server process, only when making a provider call. They are never returned by any API route, never logged, and never sent to a browser.
4. **Least privilege.** OAuth scopes are the minimum needed (for Google, not `cloud-platform`). Coding agents never open pull requests unless the user opts in for that task.

## Platform authentication

| Control | Implementation |
|---|---|
| Password storage | scrypt (N=2¹⁵, r=8, p=1, 16-byte salt, 64-byte key), `security/password.ts`. Login runs a dummy hash for unknown emails to equalise timing. |
| Sessions | 256-bit random token in the cookie. The database stores only its SHA-256 (`sessions.id`). 30-day absolute lifetime. Users can list their sessions, revoke any one, sign out everywhere, and changing the password signs out every other session. The session handle exposed by the API is a prefix of the stored hash, which can't be used to authenticate. |
| Account deletion | Requires the password again. Cancels running work, revokes every provider grant that supports revocation, then deletes the user and all cascaded data. |
| Cookie | `HttpOnly`, `SameSite=Lax`, `Path=/`. Over HTTPS it is also `Secure` and uses the `__Host-` prefix (so no `Domain` attribute and no subdomain injection). |
| API tokens | Personal access tokens (`ait_<prefix>_<256-bit secret>`). Only the SHA-256 is stored, and the plaintext is shown once. Each token has a `read` or `write` scope, an optional expiry (90 days by default, 365 at most), last-used tracking, and can be revoked. Tokens can't create tokens, change the password, delete the account, revoke sessions, or start provider OAuth: those need an interactive session, so a leaked token can't escalate or lock the owner out. |
| CSRF | Bearer-token requests are exempt. A browser can't attach an `Authorization` header cross-site without a CORS preflight, which this server never approves. For cookie sessions there are two layers on every state-changing request: (1) the `Origin` header must exactly equal `APP_URL`'s origin (or `Sec-Fetch-Site: same-origin`), otherwise the request is refused; (2) an `x-csrf-token` header must match `HMAC(SESSION_SECRET, "csrf:" + sessionId)`. The token comes from `/api/auth/login`, `/api/auth/signup` or `/api/auth/session`. Login and signup have no session yet, so they rely on the Origin check. |
| CORS | None. No `Access-Control-Allow-*` headers are sent, so other origins can't read responses. `Cross-Origin-Resource-Policy: same-origin` is also set. |
| Login throttling | 10 attempts per minute per IP, *and* 10 per 15 minutes per account (keyed by email hash), so guessing spread across many IPs is slow too. |
| Rate limiting | Token buckets per route and per user (or per IP when unauthenticated): auth 10/min, connect 20 per 5 min, task 12/min, general API 120 burst. `X-Forwarded-For` is only trusted when `TRUST_PROXY=true`. Buckets live in Postgres (`RATE_LIMIT_STORE=postgres`, the production default) so limits hold across instances. If that store is unavailable, the check falls back to the local in-memory limiter rather than failing requests. |
| Headers | `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (API-only), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-store`, and HSTS in production. |
| Authorization | Every task, team, run, message and connection query is scoped by `user_id`. Imported context is joined on `tasks.user_id` even after route-level checks (defence in depth). Tests cover cross-tenant reads. |

## Provider connection flows

### OAuth 2.0 Authorization Code + PKCE (Google, OpenAI "Sign in with ChatGPT")

```
Client ──POST /api/connections/{p} {method:"oauth"}──▶ Server
  Server: state = 256-bit random, nonce = 192-bit random, verifier = 384-bit random
          store { sha256(state), user_id, session_id, provider,
                  enc(verifier, aad="oauth:"+sha256(state)), nonce,
                  redirect_uri, expires_at = now+10m }
  ◀── { redirect: authorize URL with code_challenge=S256(verifier), state, nonce }
Browser ──▶ provider consent screen (on the provider's domain)
Provider ──302──▶ GET /api/oauth/{p}/callback?code&state
  Server: atomically consume the state row WHERE state_hash, provider,
          user_id, session_id match AND not consumed AND not expired
          check redirect_uri still equals APP_URL-derived value
          exchange code + code_verifier at the provider token endpoint
          verify ID token: RS256 signature via provider JWKS, exact iss, aud = client_id,
          exp, nonce
          encrypt access + refresh tokens, store connection
  ◀── JSON connection view (no tokens)
```

- **State** is single-use (the atomic `UPDATE … WHERE consumed_at IS NULL RETURNING`), expires after 10 minutes, and is bound to both the user and the specific session. A leaked callback URL can't be replayed, and it can't be completed from another session or account.
- **Redirect URIs** are never read from the request. They're derived from `APP_URL` as `${APP_URL}/api/oauth/<provider>/callback` and must be registered exactly with the provider.
- **PKCE** verifiers (RFC 7636, S256) are stored encrypted, not in cookies.
- **Nonce** binds the ID token to this transaction.
- **Token expiry:** before each use, a token expiring within 60 seconds is refreshed. Refreshes are single-flight per connection, so rotating refresh tokens aren't burned by parallel agents. If a refresh or API call is rejected (`invalid_grant`, 401), the connection is marked **Authentication expired** and the user is told to reconnect.
- **Revocation:** disconnecting calls the provider's revocation endpoint where one exists (Google `oauth2.googleapis.com/revoke`, and OpenAI's discovery-advertised endpoint), then deletes the encrypted tokens. Revocation failures are logged (redacted) and don't block local deletion.

### API keys (OpenAI Platform, Claude Console, Gemini, xAI Console, Cursor)

An API key is a developer credential the user creates in the provider's own console. It is validated by a read-only call (`GET /models` or `GET /v1/me`), then encrypted like an OAuth token. The API labels every key-based connection with who is billed. We never present a key as subscription delegation.

## Encryption at rest

- AES-256-GCM, a 96-bit random IV per encryption, and a 128-bit auth tag (`security/crypto.ts`).
- **Associated data** binds each ciphertext to its row and field (`<userId>:<provider>:access|refresh`, or `oauth:<stateHash>`). A ciphertext copied into another user's row fails to decrypt.
- **Key rotation:** `ENCRYPTION_KEYS="v2:<new>,v1:<old>"`. The first key encrypts and every listed key decrypts, because the envelope records its key version. To rotate, prepend a new key and re-save connections, which happens naturally on refresh or reconnect. Remove the old key once nothing references it.
- Production refuses to start without `ENCRYPTION_KEYS`, `SESSION_SECRET` and an `https://` `APP_URL`.

## Logging and audit

- Every API response carries an `x-request-id`. A valid one supplied by the client is echoed, otherwise one is generated. It appears in access logs and in the body of 500 responses, so errors can be traced without exposing internals.
- `/api/metrics` is disabled unless `METRICS_TOKEN` is set, and then requires it as a bearer token (compared in constant time). Metric labels are bounded (route patterns, provider ids, status classes) and never contain user data.
- All server logging goes through `security/redact.ts`, which strips values under secret-looking keys and anything shaped like a credential: `sk-…`, `sk-ant-…`, `xai-…`, `crsr_…`, `AIza…`, `ya29.…`, `Bearer …` and JWTs. Provider error messages are redacted before they're stored or returned.
- `provider_events` records sanitised call metadata (kind, model, status, token usage, tool names). It never records prompts, credentials or raw responses.
- `audit_events` records API token creation and revocation, sign-up, sign-in and failures, sign-out, session revocation, password changes, account deletion, connect and disconnect, OAuth start, invalid OAuth state, refresh failures and expiries, team and task changes, imports, settings changes, CSRF rejections and rate-limit hits. Each entry has the user, IP (per `TRUST_PROXY`) and user agent. Users can read their own log at `GET /api/audit`.

## Outbound webhooks

- **SSRF protection** (`security/ssrf.ts`): the URL must be `https` on port 443 or 8443, with no embedded credentials. Every address the hostname resolves to must be public. Loopback, RFC 1918, link-local (including `169.254.169.254` cloud metadata), CGNAT, multicast, reserved, documentation, IPv6 ULA and link-local, and IPv4-mapped forms of all of these are refused. The check runs when the webhook is created *and* before every delivery.
- **DNS-rebinding protection:** the delivery connects to the exact IP that passed validation (a pinned `lookup`), with TLS SNI and certificate checks against the original hostname. Redirects aren't followed, response bodies are capped at 64KB, and each attempt times out after 10 seconds.
- **Signatures:** each webhook has its own 256-bit secret, shown once and stored AES-GCM-encrypted. Deliveries carry `X-AITeam-Signature: t=…,v1=HMAC-SHA256(secret, t + "." + body)`.
- **Session-only registration:** a webhook receives future task results, so registering one requires an interactive session. A leaked API token can't add an exfiltration endpoint.
- `WEBHOOKS_ALLOW_PRIVATE=true` (for local development) is ignored in production.

## Retention

Maintenance runs on every instance every 10 minutes. It deletes expired sessions, OAuth states, idempotency keys (after 24 hours) and stale rate-limit buckets. It also deletes provider-call logs older than `PROVIDER_EVENTS_RETENTION_DAYS` (default 90) and audit entries older than `AUDIT_RETENTION_DAYS` (default 365, minimum 30).

## Data rights

`GET /api/account/export` returns every record held about the user (profile, settings, connections metadata, teams, conversations, token and webhook metadata, audit log). It never includes credentials: provider tokens, token hashes, webhook secrets and the password hash are excluded. `DELETE /api/account` erases everything.

## Agent safety

- **No hidden chain-of-thought.** Agents are asked for conclusions and short justifications. We don't request or extract providers' private reasoning. The activity feed shows assignments, tool activity, summaries, findings, reviews, disagreements and rulings.
- **Prompt injection.** Content forwarded between agents, and imported conversations, is labelled as data to evaluate rather than instructions. Model output is stored and returned as text, and clients must render it without executing HTML.
- **Per-user concurrency:** at most `MAX_CONCURRENT_RUNS` runs (default 3) per user. The check and insert happen under a per-user Postgres advisory lock, so parallel requests can't exceed it.
- **Bounded execution.** Every provider call passes a budget check for maximum calls, runtime and cost (where pricing is known). Rounds are capped by `maxRounds`, and a round repeats only if the judge requests it *and* the disputes changed. One call is reserved for the final synthesis. Users can cancel runs, and cancellation propagates to providers (Cursor runs are cancelled remotely).
- **Coding agents.** Cursor only receives work when the task names a GitHub repository its key can access. `autoCreatePR` is `false` unless `allowPullRequests: true` is sent for that task.
- **Refusals** (for example Claude's `stop_reason: "refusal"`) surface as a failed agent step, not as an empty answer.

## Conversation import

OAuth grants don't give access to a user's provider chat history, and we don't try to obtain it. Import accepts only material the user supplies: pasted text, or `conversations.json` files from ChatGPT's or Claude's official data export. Share-link and provider-API import are listed as "coming soon" until an official API exists.

## Operational notes and known limitations

- Multi-instance: live events and cancel requests travel over Postgres `LISTEN/NOTIFY`. NOTIFY payloads carry run events but never credentials. Runs are owned by one instance and kept alive by a heartbeat. A run is only marked interrupted after its owner has been silent for 45 seconds, and on `SIGTERM` in-flight runs are stopped and recorded as interrupted.
- The production container runs as a non-root user and contains no `.env` files (`.dockerignore`).
- Signup returns 409 for an existing email. This is a deliberate usability trade-off: account enumeration is possible but rate-limited.
- Sandbox agents are for local development only. They are disabled whenever `NODE_ENV=production`, and every message they produce is labelled `simulated`.
