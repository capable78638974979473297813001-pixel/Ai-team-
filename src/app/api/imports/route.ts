import { z } from "zod";
import { api, ApiError, readJson } from "@/server/auth/guard";
import { audit } from "@/server/security/audit";
import { RULES } from "@/server/security/rate-limit";
import { parseChatGPTExport, parseClaudeExport, parsePastedText, saveImported } from "@/server/services/imports";

const body = z.discriminatedUnion("source", [
  z.object({ source: z.literal("text"), title: z.string().max(120).optional(), text: z.string().min(1).max(500_000) }),
  z.object({ source: z.literal("chatgpt_export"), json: z.string().min(2).max(5_000_000) }),
  z.object({ source: z.literal("claude_export"), json: z.string().min(2).max(5_000_000) }),
]);

export const POST = api({ auth: true, rate: RULES.task, rateKey: "import" }, async ({ req, session, meta }) => {
  const input = body.parse(await readJson(req, 5_200_000));
  let convs;
  if (input.source === "text") {
    convs = [parsePastedText(input.text, input.title)];
  } else {
    let json: unknown;
    try {
      json = JSON.parse(input.json);
    } catch {
      throw new ApiError(400, "That file isn't valid JSON");
    }
    convs = input.source === "chatgpt_export" ? parseChatGPTExport(json) : parseClaudeExport(json);
  }
  convs = convs.filter((c) => c.turns.length);
  if (!convs.length) throw new ApiError(400, "No conversation turns found in that input");
  const ids = await saveImported(session.user.id, convs);
  await audit("import.create", { userId: session.user.id, ...meta }, undefined, { source: input.source, count: ids.length });
  return { ids };
});
