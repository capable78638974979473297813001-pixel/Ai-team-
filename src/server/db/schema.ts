import { sql } from "drizzle-orm";
import {
  bigserial,
  doublePrecision,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  /** Orchestration defaults and UI preferences. Never secrets. */
  settings: jsonb("settings").$type<UserSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type UserSettings = {
  limits?: Partial<RunLimits>;
};

export type RunLimits = {
  maxRounds: number;
  maxAgents: number;
  maxCalls: number;
  maxRuntimeMs: number;
  /** null = not enforced */
  maxCostUsd: number | null;
};

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token. The raw token only exists in the cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** oauth | api_key | sandbox */
    method: text("method").notNull(),
    /** connected | expired | revoked | error */
    status: text("status").notNull(),
    accountLabel: text("account_label"),
    /** Non-secret account metadata officially exposed by the provider. */
    accountInfo: jsonb("account_info").$type<Record<string, unknown>>().notNull().default({}),
    scopes: text("scopes").array().notNull().default([]),
    /** Non-secret connection parameters (e.g. Google quota project, issued OAuth client id). */
    extra: jsonb("extra").$type<Record<string, string>>().notNull().default({}),
    /** AES-256-GCM ciphertext (see security/crypto.ts). Never returned to the browser. */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    defaultModel: text("default_model"),
    models: jsonb("models").$type<string[]>().notNull().default([]),
    lastError: text("last_error"),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("provider_connections_user_provider_idx").on(t.userId, t.provider)],
);

export const oauthStates = pgTable("oauth_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** SHA-256 of the `state` parameter. */
  stateHash: text("state_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  provider: text("provider").notNull(),
  codeVerifierEnc: text("code_verifier_enc").notNull(),
  nonce: text("nonce").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  /** Non-secret extra parameters (e.g. quota project). */
  extra: jsonb("extra").$type<Record<string, string>>().notNull().default({}),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("teams_user_idx").on(t.userId)],
);

export const teamAgents = pgTable(
  "team_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    roleTitle: text("role_title").notNull(),
    /** Natural-language description of what this agent should do on the team. */
    roleInstructions: text("role_instructions").notNull().default(""),
    model: text("model"),
    isLead: boolean("is_lead").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("team_agents_team_idx").on(t.teamId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** native | import */
    source: text("source").notNull().default("native"),
    /** idle | running | completed | failed | cancelled */
    status: text("status").notNull().default("idle"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tasks_user_idx").on(t.userId, t.updatedAt, t.id)],
);

export type RunUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  elapsedMs: number;
};

export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    /** queued | running | completed | failed | cancelled */
    status: text("status").notNull().default("queued"),
    /** plan | delegate | work | review | resolve | synthesize | done */
    phase: text("phase").notNull().default("plan"),
    round: integer("round").notNull().default(0),
    limits: jsonb("limits").$type<RunLimits>().notNull(),
    /** Agents chosen for this run (provider ids + roles). */
    roster: jsonb("roster").$type<RosterEntry[]>().notNull().default([]),
    usage: jsonb("usage").$type<RunUsage>().notNull().default({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      elapsedMs: 0,
    }),
    stopReason: text("stop_reason"),
    error: text("error"),
    options: jsonb("options").$type<RunOptions>().notNull().default({}),
    /** The server process executing this run, and its liveness heartbeat. */
    instanceId: text("instance_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** Set by any instance; the owning instance aborts the run when it sees it. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("task_runs_task_idx").on(t.taskId),
    // Active-run lookups (concurrency limit, heartbeat reaper) only ever touch a handful of rows.
    index("task_runs_active_idx")
      .on(t.status, t.heartbeatAt)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export type RosterEntry = {
  key: string;
  provider: string;
  model: string | null;
  roleTitle: string;
  roleInstructions: string;
  isLead: boolean;
};

export type RunOptions = {
  autoSelect?: boolean;
  /** Only when the user explicitly opts in may a coding agent open PRs. */
  allowPullRequests?: boolean;
  repoUrl?: string | null;
  /** Imported conversation ids to include as context. */
  contextTaskIds?: string[];
};

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    agentKey: text("agent_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    roleTitle: text("role_title").notNull(),
    /** plan | work | review | judge | synthesis */
    kind: text("kind").notNull(),
    round: integer("round").notNull().default(1),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    /** queued | running | completed | failed | cancelled | skipped */
    status: text("status").notNull().default("queued"),
    output: text("output"),
    summary: text("summary"),
    findings: jsonb("findings").$type<Finding[]>().notNull().default([]),
    inputMessageIds: uuid("input_message_ids").array().notNull().default([]),
    usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number }>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("agent_runs_task_run_idx").on(t.taskRunId)],
);

export type Finding = { id: string; text: string };

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /** user | orchestrator | agent | system */
    authorType: text("author_type").notNull(),
    provider: text("provider"),
    model: text("model"),
    agentKey: text("agent_key"),
    roleTitle: text("role_title"),
    /** task | plan | assignment | output | review | disagreement | ruling | final | status | imported */
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Messages whose content was forwarded to the author of this message. */
    replyToIds: uuid("reply_to_ids").array().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("messages_task_idx").on(t.taskId, t.seq)],
);

/** Sanitised log of calls to providers (never contains credentials or raw prompts). */
export const providerEvents = pgTable(
  "provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    /** request | response | error | tool | refresh | health */
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("provider_events_run_idx").on(t.taskRunId), index("provider_events_created_idx").on(t.createdAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_user_idx").on(t.userId, t.createdAt), index("audit_events_created_idx").on(t.createdAt)],
);

/** Token buckets for the Postgres-backed rate limiter (RATE_LIMIT_STORE=postgres). */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  allowed: boolean("allowed").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Personal access tokens for programmatic API clients (`Authorization: Bearer ait_…`).
 * Only the SHA-256 of the token is stored.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** First characters of the token, shown so users can tell tokens apart. */
    prefix: text("prefix").notNull(),
    /** read | write */
    scopes: text("scopes").array().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

/** Replay protection for POSTs that carry an Idempotency-Key header. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    route: text("route").notNull(),
    /** SHA-256 of the request body, so a reused key with a different body is rejected. */
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    response: jsonb("response").$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idempotency_keys_pk").on(t.userId, t.route, t.key)],
);

/** Outbound webhooks notified when a run finishes. */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Signing secret, AES-GCM encrypted (we need the plaintext to sign). */
    secretEnc: text("secret_enc").notNull(),
    events: text("events").array().notNull(),
    disabled: boolean("disabled").notNull().default(false),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastStatus: text("last_status"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("webhooks_user_idx").on(t.userId)],
);
