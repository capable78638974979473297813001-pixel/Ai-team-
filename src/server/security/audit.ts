import { db } from "../db/client";
import { auditEvents } from "../db/schema";
import { log, redact } from "./redact";

export type AuditAction =
  | "auth.signup"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.logout_all"
  | "connection.connect"
  | "connection.connect_failed"
  | "connection.oauth_started"
  | "connection.oauth_state_invalid"
  | "connection.disconnect"
  | "connection.refresh_failed"
  | "connection.expired"
  | "team.create"
  | "team.update"
  | "team.delete"
  | "task.create"
  | "task.run"
  | "task.cancel"
  | "task.delete"
  | "import.create"
  | "settings.update"
  | "security.csrf_rejected"
  | "security.rate_limited";

export type AuditContext = { userId?: string | null; ip?: string | null; userAgent?: string | null };

export async function audit(
  action: AuditAction,
  ctx: AuditContext,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
) {
  try {
    await db()
      .insert(auditEvents)
      .values({
        action,
        userId: ctx.userId ?? null,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        metadata: redact(metadata),
      });
  } catch (err) {
    // Auditing must never break the request, but it must be visible.
    log.error(`audit write failed for ${action}`, err);
  }
}
