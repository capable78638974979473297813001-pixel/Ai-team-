import { extractJson } from "../orchestrator/protocol";
import { getAdapter, PROVIDER_IDS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { getActiveConnection, listConnections } from "./connections";
import { teamInput, type TeamInput } from "./teams";

/**
 * Turn a natural-language description ("a team to audit our payments code for
 * security issues") into a proposed team. One connected model drafts the roles;
 * if none is connected, or its answer is unusable, a deterministic draft built
 * from provider strengths is returned instead. Nothing is saved.
 */
export async function draftTeam(userId: string, description: string): Promise<{ team: TeamInput; draftedBy: string | null }> {
  const connections = await listConnections(userId);
  const connected = connections.filter((c) => c.state === "connected").map((c) => c.provider);
  const pool = (connected.length ? connected : PROVIDER_IDS).filter((p) => p !== "cursor" || /\b(code|repo|fix|implement|refactor)/i.test(description));

  const drafter = (["openai", "anthropic", "google", "xai"] as ProviderId[]).find((p) => connected.includes(p));
  if (drafter) {
    const conn = await getActiveConnection(userId, drafter);
    if (conn) {
      try {
        const catalogue = pool
          .map((p) => {
            const a = getAdapter(p);
            return `- "${p}": ${a.info.name} (${a.info.vendor}); strengths: ${a.info.strength}; capabilities: ${conn && p === drafter ? conn.capabilities.join(", ") : a.capabilities("api_key").join(", ")}`;
          })
          .join("\n");
        const conversation = await conn.adapter.createConversation(conn.credentials, {
          model: conn.defaultModel,
          system: "You design small teams of AI agents. Reply with JSON only. [protocol:team]",
        });
        const res = await conn.adapter.sendMessage(
          conn.credentials,
          conversation,
          [
            `Design an AI team for this purpose:\n${description}`,
            "",
            "Available agents (use only these provider ids, each at most once):",
            catalogue,
            "",
            "Give each agent a short role title and 1–2 sentences of role instructions in plain language. Mark exactly one as lead (it plans and writes the final answer). Use 2–5 agents.",
            'Reply with only a JSON object: {"name": "…", "description": "…", "agents": [{"provider": "<id>", "roleTitle": "…", "roleInstructions": "…", "isLead": false}]}',
          ].join("\n"),
          { signal: AbortSignal.timeout(90_000), maxOutputTokens: 2_000 },
        );
        const parsed = teamInput.safeParse(extractJson(res.text));
        if (parsed.success) {
          const agents = parsed.data.agents.filter((a, i, all) => pool.includes(a.provider as ProviderId) && all.findIndex((b) => b.provider === a.provider) === i);
          if (agents.length) return { team: normaliseLead({ ...parsed.data, agents }), draftedBy: drafter };
        }
      } catch {
        /* fall through to the deterministic draft */
      }
    }
  }
  return { team: heuristicTeam(description, pool), draftedBy: null };
}

function normaliseLead(team: TeamInput): TeamInput {
  const lead = Math.max(0, team.agents.findIndex((a) => a.isLead));
  return { ...team, agents: team.agents.map((a, i) => ({ ...a, isLead: i === lead })) };
}

export function heuristicTeam(description: string, pool: ProviderId[]): TeamInput {
  const d = description.toLowerCase();
  const wantsResearch = /research|market|news|current|trend|compare|competit/.test(d);
  const wantsCode = /code|repo|bug|security|audit|architecture|api|refactor|review/.test(d);
  const order: ProviderId[] = wantsCode
    ? ["anthropic", "openai", "google", "xai", "cursor"]
    : wantsResearch
      ? ["openai", "google", "xai", "anthropic"]
      : ["openai", "anthropic", "google", "xai"];
  const chosen = order.filter((p) => pool.includes(p)).slice(0, 4);
  const agents = chosen.map((p, i) => {
    const role = getAdapter(p).info.defaultRole;
    return { provider: p, roleTitle: role.title, roleInstructions: `${role.instructions} Focus: ${description.slice(0, 200)}`, model: null, isLead: i === 0 };
  });
  const name = description.split(/[.\n]/)[0]!.trim().slice(0, 60) || "New team";
  return { name: name.charAt(0).toUpperCase() + name.slice(1), description: description.slice(0, 500), agents };
}
