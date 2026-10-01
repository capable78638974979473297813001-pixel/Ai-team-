import { NextResponse } from "next/server";
import { api } from "@/server/auth/guard";
import { RULES } from "@/server/security/rate-limit";
import { exportAccount } from "@/server/services/export";

/** Download all of your data as JSON (no credentials). */
export const GET = api({ auth: true, sessionOnly: true, rate: RULES.connect, rateKey: "export" }, async ({ session }) => {
  const data = await exportAccount(session.user.id);
  return NextResponse.json(data, {
    headers: { "content-disposition": `attachment; filename="ai-team-export-${new Date().toISOString().slice(0, 10)}.json"` },
  });
});
