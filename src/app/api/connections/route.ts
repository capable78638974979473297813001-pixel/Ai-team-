import { api } from "@/server/auth/guard";
import { listConnections } from "@/server/services/connections";

export const GET = api({ auth: true }, async ({ session }) => ({ connections: await listConnections(session.user.id) }));
