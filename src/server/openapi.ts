/** OpenAPI 3.1 description of the public API, served at GET /api/openapi.json. */
const json = (schema: object, description = "OK") => ({ description, content: { "application/json": { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const err = { description: "Error", content: { "application/json": { schema: ref("Error") } } };
const idParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string" } });
const mutating = { security: [{ bearer: [] }, { session: [], csrf: [] }] };
const sessionOnly = { security: [{ session: [], csrf: [] }], description: "Requires an interactive cookie session; API tokens are refused." };
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 8, maxLength: 100 },
  description: "Retries with the same key and body replay the original response (24h).",
};

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "AI Team API",
    version: "0.3.0",
    description:
      "Your AI accounts. One team. Connect AI providers with their official auth methods and run multi-agent tasks. " +
      "Authenticate with a personal access token (`Authorization: Bearer ait_…`) or a session cookie. " +
      "Cookie-authenticated state-changing requests also need an Origin header equal to APP_URL and an x-csrf-token header. " +
      "Every response carries x-request-id.",
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "Personal access token from POST /api/tokens (scopes: read, write)" },
      session: { type: "apiKey", in: "cookie", name: "__Host-aiteam_session" },
      csrf: { type: "apiKey", in: "header", name: "x-csrf-token" },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" }, code: { type: "string" } }, required: ["error"] },
      User: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string" } } },
      Limits: {
        type: "object",
        properties: {
          maxRounds: { type: "integer", minimum: 1, maximum: 4 },
          maxAgents: { type: "integer", minimum: 1, maximum: 6 },
          maxCalls: { type: "integer", minimum: 2, maximum: 40 },
          maxRuntimeMs: { type: "integer", minimum: 30000, maximum: 1800000 },
          maxCostUsd: { type: ["number", "null"] },
        },
      },
      ConnectionMethod: {
        type: "object",
        properties: {
          id: { enum: ["oauth", "api_key", "sandbox"] },
          label: { type: "string" },
          availability: { enum: ["available", "not_configured", "coming_soon", "unsupported"] },
          reason: { type: "string" },
          billing: { type: "string" },
          subscriptionDelegation: { type: "boolean" },
        },
      },
      Connection: {
        type: "object",
        properties: {
          provider: { enum: ["openai", "anthropic", "google", "xai", "cursor"] },
          name: { type: "string" },
          state: { enum: ["connected", "not_connected", "unsupported", "coming_soon", "expired", "error"] },
          method: { type: ["string", "null"] },
          methods: { type: "array", items: ref("ConnectionMethod") },
          capabilities: { type: "array", items: { type: "string" } },
          accountLabel: { type: ["string", "null"] },
          accountInfo: { type: "object" },
          models: { type: "array", items: { type: "string" } },
          defaultModel: { type: ["string", "null"] },
          simulated: { type: "boolean" },
        },
      },
      TeamAgent: {
        type: "object",
        required: ["provider", "roleTitle"],
        properties: {
          provider: { type: "string" },
          roleTitle: { type: "string" },
          roleInstructions: { type: "string", description: "Natural-language role description" },
          model: { type: ["string", "null"] },
          isLead: { type: "boolean" },
        },
      },
      TeamInput: {
        type: "object",
        required: ["name", "agents"],
        properties: { name: { type: "string" }, description: { type: "string" }, agents: { type: "array", items: ref("TeamAgent") } },
      },
      RunRequest: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", maxLength: 20000 },
          teamId: { type: ["string", "null"], format: "uuid" },
          providers: { type: "array", items: { type: "string" }, description: "Explicit agent selection; omit for auto-select" },
          repoUrl: { type: ["string", "null"], description: "https://github.com/owner/repo" },
          allowPullRequests: { type: "boolean", default: false },
          contextTaskIds: { type: "array", items: { type: "string", format: "uuid" }, description: "Imported conversations to use as context" },
          limits: ref("Limits"),
        },
      },
      Message: {
        type: "object",
        properties: {
          id: { type: "string" },
          seq: { type: "integer" },
          authorType: { enum: ["user", "orchestrator", "agent", "system"] },
          provider: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          agentKey: { type: ["string", "null"] },
          roleTitle: { type: ["string", "null"] },
          kind: { enum: ["task", "plan", "assignment", "output", "review", "disagreement", "ruling", "status", "final", "imported"] },
          content: { type: "string" },
          metadata: { type: "object" },
          replyToIds: { type: "array", items: { type: "string" }, description: "Messages forwarded to this message's author" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
  paths: {
    "/api/auth/signup": { post: { summary: "Create an account and session", responses: { 200: json({ properties: { user: ref("User"), csrfToken: { type: "string" } } }), 409: err } } },
    "/api/auth/login": { post: { summary: "Sign in", responses: { 200: json({ properties: { user: ref("User"), csrfToken: { type: "string" } } }), 401: err } } },
    "/api/auth/session": { get: { summary: "Current user and CSRF token", security: [{ session: [] }], responses: { 200: json({}), 401: err } } },
    "/api/auth/logout": { post: { summary: "End this session", ...sessionOnly, responses: { 200: json({}) } } },
    "/api/auth/logout-all": { post: { summary: "End every session", ...sessionOnly, responses: { 200: json({}) } } },
    "/api/auth/sessions": { get: { summary: "List sessions", security: [{ session: [] }], responses: { 200: json({}) } } },
    "/api/tokens": {
      get: { summary: "List personal access tokens", ...sessionOnly, responses: { 200: json({}) } },
      post: {
        summary: "Create a personal access token (plaintext returned once)",
        ...sessionOnly,
        requestBody: { content: { "application/json": { schema: { properties: { name: { type: "string" }, scopes: { type: "array", items: { enum: ["read", "write"] } }, expiresInDays: { type: ["integer", "null"] } } } } } },
        responses: { 200: json({ properties: { token: { type: "string" } } }) },
      },
    },
    "/api/tokens/{id}": { delete: { summary: "Revoke a personal access token", ...sessionOnly, parameters: [idParam()], responses: { 200: json({}), 404: err } } },
    "/api/teams/draft": {
      post: {
        summary: "Draft a team from a natural-language description (not saved)",
        ...mutating,
        requestBody: { content: { "application/json": { schema: { properties: { description: { type: "string" } }, required: ["description"] } } } },
        responses: { 200: json({ properties: { team: ref("TeamInput"), draftedBy: { type: ["string", "null"] } } }) },
      },
    },
    "/api/auth/sessions/{id}": { delete: { summary: "Revoke a session", ...sessionOnly, parameters: [idParam()], responses: { 200: json({}), 404: err } } },
    "/api/auth/password": { post: { summary: "Change password (signs out other sessions)", ...sessionOnly, responses: { 200: json({}), 401: err } } },
    "/api/account": { delete: { summary: "Delete the account (requires password)", ...sessionOnly, responses: { 200: json({}), 401: err } } },
    "/api/audit": { get: { summary: "Your security/activity log", security: [{ session: [] }], responses: { 200: json({}) } } },
    "/api/providers": { get: { summary: "Supported providers, connection methods and capabilities", responses: { 200: json({}) } } },
    "/api/connections": { get: { summary: "Your connections", security: [{ session: [] }], responses: { 200: json({ properties: { connections: { type: "array", items: ref("Connection") } } }) } } },
    "/api/connections/{provider}": {
      post: {
        summary: "Connect: api_key (validated, encrypted), oauth (returns {redirect}), or sandbox (dev only)",
        ...mutating,
        parameters: [idParam("provider")],
        requestBody: { content: { "application/json": { schema: { properties: { method: { enum: ["oauth", "api_key", "sandbox"] }, apiKey: { type: "string" }, fields: { type: "object" } }, required: ["method"] } } } },
        responses: { 200: json({}), 400: err, 502: err },
      },
      patch: { summary: "Set default model", ...mutating, parameters: [idParam("provider")], responses: { 200: json({}) } },
      delete: { summary: "Disconnect (revokes at the provider where supported)", ...mutating, parameters: [idParam("provider")], responses: { 200: json({}) } },
    },
    "/api/connections/{provider}/health": { post: { summary: "Health-check a connection", ...mutating, parameters: [idParam("provider")], responses: { 200: json({}) } } },
    "/api/oauth/{provider}/callback": { get: { summary: "OAuth redirect target", parameters: [idParam("provider")], responses: { 200: json({}), 400: err } } },
    "/api/teams": {
      get: { summary: "List teams", security: [{ session: [] }], responses: { 200: json({}) } },
      post: { summary: "Create a team", ...mutating, requestBody: { content: { "application/json": { schema: ref("TeamInput") } } }, responses: { 200: json({}) } },
    },
    "/api/teams/{id}": {
      put: { summary: "Update a team", ...mutating, parameters: [idParam()], requestBody: { content: { "application/json": { schema: ref("TeamInput") } } }, responses: { 200: json({}) } },
      delete: { summary: "Delete a team", ...mutating, parameters: [idParam()], responses: { 200: json({}) } },
    },
    "/api/tasks": {
      get: {
        summary: "List conversations (keyset-paginated)",
        security: [{ bearer: [] }, { session: [] }],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { 200: json({ properties: { tasks: { type: "array" }, nextCursor: { type: ["string", "null"] } } }) },
      },
      post: { summary: "Start a task", ...mutating, parameters: [idempotencyHeader], requestBody: { content: { "application/json": { schema: ref("RunRequest") } } }, responses: { 200: json({ properties: { taskId: { type: "string" }, runId: { type: "string" } } }), 400: err } },
    },
    "/api/tasks/{id}": {
      get: { summary: "Full thread: runs, messages, agent runs, tool activity", security: [{ session: [] }], parameters: [idParam()], responses: { 200: json({ properties: { messages: { type: "array", items: ref("Message") } } }), 404: err } },
      patch: { summary: "Rename", ...mutating, parameters: [idParam()], responses: { 200: json({}) } },
      delete: { summary: "Delete", ...mutating, parameters: [idParam()], responses: { 200: json({}) } },
    },
    "/api/tasks/{id}/runs": { post: { summary: "Follow-up message in the same conversation", ...mutating, parameters: [idParam(), idempotencyHeader], requestBody: { content: { "application/json": { schema: ref("RunRequest") } } }, responses: { 200: json({}), 409: err } } },
    "/api/tasks/{id}/cancel": { post: { summary: "Stop the team (works across instances)", ...mutating, parameters: [idParam()], responses: { 200: json({}) } } },
    "/api/tasks/{id}/stream": {
      get: {
        summary: "Server-Sent Events: snapshot, then run / message / agent / delta / tool events",
        description:
          "Snapshot agentRuns include partialOutput for agents mid-response. Apply deltas as text = text.slice(0, offset) + delta.text; " +
          "the server fills any gap before sending, so a reconnect (to any instance) rebuilds the exact text.",
        security: [{ session: [] }],
        parameters: [idParam()],
        responses: { 200: { description: "text/event-stream", content: { "text/event-stream": { schema: { type: "string" } } } } },
      },
    },
    "/api/imports": { post: { summary: "Import a conversation (pasted text or official ChatGPT/Claude export)", ...mutating, responses: { 200: json({}) } } },
    "/api/settings": {
      get: { summary: "Default orchestration limits", security: [{ session: [] }], responses: { 200: json({ properties: { limits: ref("Limits") } }) } },
      put: { summary: "Update default limits", ...mutating, responses: { 200: json({}) } },
    },
    "/api/health": { get: { summary: "Liveness + database check", responses: { 200: json({}), 503: err } } },
  },
} as const;
