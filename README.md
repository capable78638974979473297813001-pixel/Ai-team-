# AI Team

**Your AI accounts. One team.**

AI Team is a backend service. You connect your AI providers (ChatGPT/OpenAI, Claude, Gemini, Grok, Cursor) through each provider's official authorization method, and those connections become agents that work on one task *together*. They plan, split the work, review each other, resolve disagreements, and produce one synthesised answer.

It's an API. It serves no UI. The conversation works like a group chat with named AI teammates (in the style of xAI's Grok Bot): you post a task, and the team's messages stream back over Server-Sent Events.

- [PROVIDERS.md](./PROVIDERS.md): what each provider officially allows, and what we implement
- [SECURITY.md](./SECURITY.md): the authentication and token-handling architecture

## How a task runs

```
TASK ─▶ PLAN ─▶ DELEGATE ─▶ AGENTS WORK ─▶ CROSS-REVIEW ─▶ RESOLVE DISAGREEMENTS ─▶ FINAL SYNTHESIS
                                  ▲                                  │
                                  └──── revision round (bounded) ◀───┘
```

1. **Plan:** the lead agent receives the task and the roster (roles and capabilities). It returns a JSON plan saying which agents are useful, what each does, which outputs need verification, and which need web search. If the plan is missing or invalid, a deterministic role-based planner takes over.
2. **Delegate:** the orchestrator posts one assignment per agent.
3. **Work:** agents work in parallel and reply in a fixed format: `SUMMARY`, then numbered `FINDINGS` `[F1]…`, then `DETAILS`.
4. **Cross-review:** each verifiable output goes to a *different* agent, preferring critic or reviewer roles and balancing load. That agent receives the author's findings, for example: "Review these 7 findings. Identify which are correct, incorrect, incomplete or uncertain."
5. **Disagreements:** any `incorrect` or `incomplete` verdict becomes a dispute (D1, D2, …).
6. **Resolve:** an agent that isn't involved in the dispute acts as judge. It receives both sides, rules on each point, and may ask named agents to revise.
7. **Another round?** Only if the judge asks, the round limit allows it, the budget allows it, *and* the disputes differ from the previous round. Otherwise the orchestrator stops, which prevents loops.
8. **Synthesis:** the lead writes the final answer from the work, reviews and rulings. One call is always reserved for this. If every agent fails, you still get a deterministic summary of the findings.

Limits are configurable per user and per task: `maxRounds` (1–4), `maxAgents` (1–6), `maxCalls` (2–40), `maxRuntimeMs` (30s–30m), and `maxCostUsd` (enforced where the price is known).

Every message records its `provider`, `model`, `agentKey` and `roleTitle`. It also records `replyToIds`, meaning which earlier messages were forwarded to its author. That gives you the full "how the team got here" trail without exposing any provider's private chain-of-thought.

## Provider support at a glance

| Provider | Official subscription sign-in | Implemented |
|---|---|---|
| ChatGPT / OpenAI | Sign in with ChatGPT (OAuth + PKCE). Hosted apps need OpenAI approval. | Adapter complete. Turned on by `OPENAI_SIWC_CLIENT_ID`, otherwise **Coming soon**. API key works now. |
| Claude / Anthropic | **Not permitted** for third-party apps | API key. Subscription shown as **Unsupported**. |
| Gemini / Google | Google OAuth (billed to a Cloud project, not a consumer plan) | **Google OAuth works end to end** (set `GOOGLE_CLIENT_ID`/`SECRET`), plus API key |
| Grok / xAI | No public third-party OAuth docs | API key. Subscription shown as **Coming soon**. |
| Cursor | No OAuth | API key for the Cloud Agents API (repository coding work) |

To add a provider, implement `ProviderAdapter` (`src/server/providers/types.ts`) and register it in `registry.ts`.

## Setup

Requirements: Node 20.9+ and PostgreSQL 14+.

```bash
npm install
npm run setup          # writes .env.local with fresh ENCRYPTION_KEYS and SESSION_SECRET
# edit DATABASE_URL in .env.local if needed, then:
npm run db:migrate
npm run dev            # http://localhost:3000
```

Other commands:

```bash
npm test               # unit + integration tests (in-memory Postgres via PGlite)
npm run smoke          # end-to-end test against a running dev server (sandbox agents)
npm run lint && npm run typecheck
npm run build && npm start   # production (requires https APP_URL + secrets)
```

For local development without any provider keys, `ENABLE_SANDBOX_AGENTS=true` (the default outside production) adds a **Sandbox (simulated)** connection method to every provider. Sandbox agents follow the full protocol with deterministic output, and their messages are marked `metadata.simulated = true`.

Configuration is listed in [.env.example](./.env.example).

## API

All requests and responses are JSON. Every state-changing request must send an `Origin` header equal to `APP_URL` and an `x-csrf-token` header (except login and signup). The session is a cookie.

```bash
H='-H content-type:application/json -H origin:http://localhost:3000'
# Sign up. The response includes a csrfToken.
curl -c jar -b jar $H -d '{"name":"Ada","email":"ada@example.com","password":"a long password"}' localhost:3000/api/auth/signup
CSRF=...   # from the response

# What can I connect?
curl -b jar localhost:3000/api/connections

# Connect with an API key (validated against the provider, encrypted at rest)
curl -b jar $H -H "x-csrf-token: $CSRF" -d '{"method":"api_key","apiKey":"sk-ant-..."}' localhost:3000/api/connections/anthropic

# Or start OAuth: open the returned URL in a browser. The provider redirects to /api/oauth/google/callback.
curl -b jar $H -H "x-csrf-token: $CSRF" -d '{"method":"oauth","fields":{"quotaProject":"my-gcp-project"}}' localhost:3000/api/connections/google

# Give the team a task (auto-selects agents, or pass "teamId" or "providers")
curl -b jar $H -H "x-csrf-token: $CSRF" -d '{"prompt":"Is https://github.com/org/repo production ready?","repoUrl":"https://github.com/org/repo"}' localhost:3000/api/tasks

# Watch the team work (SSE)
curl -N -b jar localhost:3000/api/tasks/<taskId>/stream
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup`, `/api/auth/login` | Create a session. Returns `{ user, csrfToken }`. |
| GET | `/api/auth/session` | Current user and CSRF token |
| POST | `/api/auth/logout`, `/api/auth/logout-all` | End this session, or every session |
| GET | `/api/providers` | Providers, connection methods (availability, billing) and capabilities |
| GET | `/api/connections` | Your connection states: `connected`, `not_connected`, `unsupported`, `coming_soon`, `expired` |
| POST | `/api/connections/:provider` | `{method:"api_key", apiKey}`, `{method:"oauth", fields}` (returns `{redirect}`), or `{method:"sandbox"}` |
| PATCH | `/api/connections/:provider` | `{defaultModel}` |
| DELETE | `/api/connections/:provider` | Disconnect (revokes at the provider where supported) |
| POST | `/api/connections/:provider/health` | Health check. Marks expired credentials. |
| GET | `/api/oauth/:provider/callback` | OAuth redirect target |
| GET/POST | `/api/teams` | List, or create `{name, description, agents:[{provider, roleTitle, roleInstructions, model?, isLead?}]}` |
| PUT/DELETE | `/api/teams/:id` | Update or delete a team |
| GET/POST | `/api/tasks` | List conversations, or start a task `{prompt, teamId?, providers?, repoUrl?, allowPullRequests?, contextTaskIds?, limits?}` |
| GET/PATCH/DELETE | `/api/tasks/:id` | Full thread (runs, messages, agent runs, tool activity), rename, delete |
| POST | `/api/tasks/:id/runs` | Follow-up message in the same conversation |
| POST | `/api/tasks/:id/cancel` | Stop the running team |
| GET | `/api/tasks/:id/stream` | SSE: `snapshot`, then `run`, `message`, `agent`, `delta`, `tool` |
| POST | `/api/imports` | Import `{source:"text", text}`, `{source:"chatgpt_export", json}` or `{source:"claude_export", json}` |
| GET/PUT | `/api/settings` | Default orchestration limits |
| GET | `/api/health` | Liveness and database check |

### Message kinds in a thread

`task` (you) · `plan` · `assignment` (orchestrator → agent) · `output` (agent work, with `metadata.summary` and `metadata.findings`) · `review` (`replyToIds` → the reviewed output) · `disagreement` · `ruling` (judge) · `status` · `final` (the team's answer) · `imported`

## Project layout

```
src/server/
  env.ts                    validated configuration
  db/schema.ts              users, sessions, provider_connections, oauth_states, teams, team_agents,
                            tasks, task_runs, agent_runs, messages, provider_events, audit_events
  security/                 crypto (AES-GCM), password (scrypt), pkce, rate-limit, redact, audit
  auth/                     sessions, CSRF, API route guard
  providers/                ProviderAdapter + OpenAI, Anthropic, Google, xAI, Cursor, sandbox
  orchestrator/             protocol (prompts/parsers), engine, budget, runner, event bus
  services/                 connections, oauth, teams, tasks, imports, users
src/app/api/                route handlers
drizzle/                    SQL migrations
tests/                      Vitest suites
scripts/                    migrate, setup-env, smoke
```
