import { api } from "@/server/auth/guard";
import { csrfTokenFor } from "@/server/auth/session";

/** Current user and the session-bound CSRF token. */
export const GET = api({ auth: true }, async ({ session }) => ({ user: session.user, csrfToken: csrfTokenFor(session.id) }));
