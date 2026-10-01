import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { providerConnections, providerEvents } from "../db/schema";
import { audit } from "../security/audit";
import { decrypt, encrypt } from "../security/crypto";
import { log } from "../security/redact";
import { getAdapter, methodsFor, PROVIDER_IDS, runtimeAdapter } from "../providers/registry";
import {
  AuthExpiredError,
  type Capability,
  type ConnectedAccount,
  type ConnectionMethodInfo,
  type Credentials,
  type MethodId,
  type ProviderAdapter,
  type ProviderId,
} from "../providers/types";

export type ConnectionState = "connected" | "not_connected" | "unsupported" | "coming_soon" | "expired" | "error";

/** Safe-to-render view of a provider connection. Contains no secrets. */
export type ConnectionView = {
  provider: ProviderId;
  name: string;
  product: string;
  vendor: string;
  strength: string;
  docsUrl: string;
  state: ConnectionState;
  method: MethodId | null;
  methods: ConnectionMethodInfo[];
  capabilities: Capability[];
  accountLabel: string | null;
  accountInfo: Record<string, unknown>;
  models: string[];
  defaultModel: string | null;
  lastError: string | null;
  connectedAt: string | null;
  simulated: boolean;
};

const aad = (userId: string, provider: string, field: "access" | "refresh") => `${userId}:${provider}:${field}`;

export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const rows = await db().select().from(providerConnections).where(eq(providerConnections.userId, userId));
  return PROVIDER_IDS.map((id) => {
    const adapter = getAdapter(id);
    const methods = methodsFor(id);
    const row = rows.find((r) => r.provider === id);
    const real = methods.filter((m) => m.id !== "sandbox");
    let state: ConnectionState;
    if (row) {
      const expiredByTime = row.tokenExpiresAt && row.tokenExpiresAt < new Date() && !row.refreshTokenEnc;
      state = row.status === "connected" && !expiredByTime ? "connected" : row.status === "error" ? "error" : "expired";
    } else if (methods.some((m) => m.availability === "available")) {
      state = "not_connected";
    } else if (real.some((m) => m.availability === "coming_soon" || m.availability === "not_configured")) {
      state = "coming_soon";
    } else {
      state = "unsupported";
    }
    const method = (row?.method as MethodId | undefined) ?? null;
    return {
      provider: id,
      name: adapter.info.name,
      product: adapter.info.product,
      vendor: adapter.info.vendor,
      strength: adapter.info.strength,
      docsUrl: adapter.info.docsUrl,
      state,
      method,
      methods,
      capabilities: method ? runtimeAdapter(id, method).capabilities(method) : adapter.capabilities("api_key"),
      accountLabel: row?.accountLabel ?? null,
      accountInfo: row?.accountInfo ?? {},
      models: row?.models ?? [],
      defaultModel: row?.defaultModel ?? null,
      lastError: row?.lastError ?? null,
      connectedAt: row?.createdAt.toISOString() ?? null,
      simulated: method === "sandbox",
    } satisfies ConnectionView;
  });
}

export async function saveConnection(
  userId: string,
  provider: ProviderId,
  credentials: Credentials,
  account: ConnectedAccount,
) {
  const values = {
    userId,
    provider,
    method: credentials.method,
    status: "connected",
    accountLabel: account.label,
    accountInfo: account.info,
    scopes: credentials.scopes,
    extra: credentials.extra,
    accessTokenEnc: encrypt(credentials.accessToken, aad(userId, provider, "access")),
    refreshTokenEnc: credentials.refreshToken ? encrypt(credentials.refreshToken, aad(userId, provider, "refresh")) : null,
    tokenExpiresAt: credentials.expiresAt ?? null,
    defaultModel: account.defaultModel,
    models: account.models,
    lastError: null,
    lastHealthAt: new Date(),
    updatedAt: new Date(),
  };
  await db()
    .insert(providerConnections)
    .values(values)
    .onConflictDoUpdate({ target: [providerConnections.userId, providerConnections.provider], set: values });
}

type Row = typeof providerConnections.$inferSelect;

function rowToCredentials(row: Row): Credentials {
  if (!row.accessTokenEnc) throw new AuthExpiredError("No stored credential");
  return {
    method: row.method as MethodId,
    accessToken: decrypt(row.accessTokenEnc, aad(row.userId, row.provider, "access")),
    refreshToken: row.refreshTokenEnc ? decrypt(row.refreshTokenEnc, aad(row.userId, row.provider, "refresh")) : null,
    expiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    extra: { ...row.extra, ...(row.defaultModel ? { defaultModel: row.defaultModel } : {}) },
  };
}

export type ActiveConnection = {
  provider: ProviderId;
  adapter: ProviderAdapter;
  credentials: Credentials;
  defaultModel: string | null;
  capabilities: Capability[];
  simulated: boolean;
};

/**
 * Load decrypted, fresh credentials for server-side use. Refreshes OAuth
 * tokens that expire within a minute; marks the connection expired if the
 * provider rejects the refresh.
 */
export async function getActiveConnection(userId: string, provider: ProviderId): Promise<ActiveConnection | null> {
  const [row] = await db()
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
  if (!row || row.status !== "connected") return null;
  const method = row.method as MethodId;
  const adapter = runtimeAdapter(provider, method);
  let credentials = rowToCredentials(row);

  if (credentials.expiresAt && credentials.expiresAt.getTime() - Date.now() < 60_000) {
    try {
      credentials = await singleFlightRefresh(`${userId}:${provider}`, async () => {
        const next = await adapter.refreshAuth(credentials);
        await persistRefreshed(userId, provider, next);
        await db().insert(providerEvents).values({ userId, provider, type: "refresh", data: { ok: true } });
        return next;
      });
    } catch (err) {
      await audit("connection.refresh_failed", { userId }, { type: "provider", id: provider }, {
        permanent: err instanceof AuthExpiredError,
      });
      await db()
        .insert(providerEvents)
        .values({ userId, provider, type: "refresh", data: { ok: false, permanent: err instanceof AuthExpiredError } });
      if (err instanceof AuthExpiredError) {
        // The provider rejected the grant (revoked, expired refresh token): the user must reconnect.
        await markExpired(userId, provider, err.message);
        return null;
      }
      // Transient failure (network, 5xx): keep the connection. Use the current token while it is still valid.
      if (!credentials.expiresAt || credentials.expiresAt.getTime() <= Date.now()) return null;
    }
  }
  return {
    provider,
    adapter,
    credentials,
    defaultModel: row.defaultModel,
    capabilities: adapter.capabilities(method),
    simulated: method === "sandbox",
  };
}

/**
 * Parallel agents can hit an expiring token at the same moment. Providers that
 * rotate refresh tokens would reject the second refresh, so only one runs per
 * connection and the others share its result.
 */
const inflightRefresh = new Map<string, Promise<Credentials>>();
function singleFlightRefresh(key: string, fn: () => Promise<Credentials>) {
  let p = inflightRefresh.get(key);
  if (!p) {
    p = fn().finally(() => inflightRefresh.delete(key));
    inflightRefresh.set(key, p);
  }
  return p;
}

async function persistRefreshed(userId: string, provider: ProviderId, c: Credentials) {
  await db()
    .update(providerConnections)
    .set({
      accessTokenEnc: encrypt(c.accessToken, aad(userId, provider, "access")),
      refreshTokenEnc: c.refreshToken ? encrypt(c.refreshToken, aad(userId, provider, "refresh")) : null,
      tokenExpiresAt: c.expiresAt ?? null,
      status: "connected",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
}

export async function markExpired(userId: string, provider: ProviderId, reason: string) {
  await db()
    .update(providerConnections)
    .set({ status: "expired", lastError: reason.slice(0, 300), updatedAt: new Date() })
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
  await audit("connection.expired", { userId }, { type: "provider", id: provider });
}

export async function disconnectProvider(userId: string, provider: ProviderId) {
  const [row] = await db()
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
  if (!row) return false;
  try {
    const creds = rowToCredentials(row);
    await runtimeAdapter(provider, row.method as MethodId).disconnect(creds);
  } catch (err) {
    log.warn(`revocation failed for ${provider}`, { message: (err as Error).message });
  }
  await db()
    .delete(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
  return true;
}

export async function setDefaultModel(userId: string, provider: ProviderId, model: string) {
  const [row] = await db()
    .select({ models: providerConnections.models, method: providerConnections.method })
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
  if (!row) throw new Error("Not connected");
  if (row.models.length && !row.models.includes(model)) throw new Error("Unknown model for this connection");
  await db()
    .update(providerConnections)
    .set({ defaultModel: model, updatedAt: new Date() })
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
}

export async function checkHealth(userId: string, provider: ProviderId) {
  const conn = await getActiveConnection(userId, provider);
  if (!conn) return { ok: false, expired: true };
  const result = await conn.adapter.healthCheck(conn.credentials);
  if (result.expired) {
    await markExpired(userId, provider, result.detail ?? "Rejected by provider");
    return result;
  }
  // Providers add and retire models; refresh the list and keep the default valid.
  let modelPatch: { models?: string[]; defaultModel?: string | null } = {};
  if (result.ok && conn.adapter.listModels && !conn.simulated) {
    try {
      const models = await conn.adapter.listModels(conn.credentials);
      if (models.length) {
        const keep = conn.defaultModel && models.includes(conn.defaultModel);
        modelPatch = { models, defaultModel: keep ? conn.defaultModel : conn.adapter.defaultModelFor(models) };
      }
    } catch {
      /* the health check itself passed; keep the old list */
    }
  }
  await db()
    .update(providerConnections)
    .set({ lastHealthAt: new Date(), lastError: result.ok ? null : (result.detail ?? null), ...modelPatch, updatedAt: new Date() })
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)));
  return { ...result, models: modelPatch.models, defaultModel: modelPatch.defaultModel };
}
