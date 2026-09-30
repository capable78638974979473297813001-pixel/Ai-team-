import { api } from "@/server/auth/guard";
import { listAudit } from "@/server/services/account";

/** Your own security and activity log. */
export const GET = api({ auth: true }, async ({ req, session }) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50;
  return { events: await listAudit(session.user.id, limit) };
});
