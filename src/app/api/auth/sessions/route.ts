import { api } from "@/server/auth/guard";
import { listSessions } from "@/server/services/account";

export const GET = api({ auth: true }, async ({ session }) => ({ sessions: await listSessions(session.user.id, session.id) }));
