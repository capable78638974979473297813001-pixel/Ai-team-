import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { teamAgents, teams, type RosterEntry } from "../db/schema";
import { getAdapter, isProviderId, PROVIDER_IDS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { listConnections } from "./connections";

export const teamInput = z.object({
  name: z.string().trim().min(1, "Give the team a name").max(80),
  description: z.string().trim().max(500).default(""),
  agents: z
    .array(
      z.object({
        provider: z.string().refine(isProviderId, "Unknown provider"),
        roleTitle: z.string().trim().min(1, "Every agent needs a role").max(60),
        roleInstructions: z.string().trim().max(2000).default(""),
        model: z.string().trim().max(120).nullable().default(null),
        isLead: z.boolean().default(false),
      }),
    )
    .min(1, "Add at least one agent")
    .max(8),
});
export type TeamInput = z.infer<typeof teamInput>;

export type TeamView = {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  agents: { id: string; provider: ProviderId; name: string; roleTitle: string; roleInstructions: string; model: string | null; isLead: boolean }[];
};

export async function listTeams(userId: string): Promise<TeamView[]> {
  const rows = await db().select().from(teams).where(eq(teams.userId, userId)).orderBy(desc(teams.updatedAt));
  if (!rows.length) return [];
  const agents = await db()
    .select()
    .from(teamAgents)
    .where(inArray(teamAgents.teamId, rows.map((r) => r.id)))
    .orderBy(asc(teamAgents.position));
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    updatedAt: t.updatedAt.toISOString(),
    agents: agents
      .filter((a) => a.teamId === t.id && isProviderId(a.provider))
      .map((a) => ({
        id: a.id,
        provider: a.provider as ProviderId,
        name: getAdapter(a.provider as ProviderId).info.name,
        roleTitle: a.roleTitle,
        roleInstructions: a.roleInstructions,
        model: a.model,
        isLead: a.isLead,
      })),
  }));
}

export async function getTeam(userId: string, teamId: string) {
  return (await listTeams(userId)).find((t) => t.id === teamId) ?? null;
}

export async function saveTeam(userId: string, input: TeamInput, teamId?: string) {
  const data = teamInput.parse(input);
  // Exactly one lead: the first one flagged, else the first agent.
  const leadIndex = Math.max(0, data.agents.findIndex((a) => a.isLead));
  return db().transaction(async (tx) => {
    let id = teamId;
    if (id) {
      const updated = await tx
        .update(teams)
        .set({ name: data.name, description: data.description, updatedAt: new Date() })
        .where(and(eq(teams.id, id), eq(teams.userId, userId)))
        .returning({ id: teams.id });
      if (!updated.length) throw new Error("Team not found");
      await tx.delete(teamAgents).where(eq(teamAgents.teamId, id));
    } else {
      const [row] = await tx.insert(teams).values({ userId, name: data.name, description: data.description }).returning({ id: teams.id });
      id = row!.id;
    }
    await tx.insert(teamAgents).values(
      data.agents.map((a, i) => ({
        teamId: id!,
        provider: a.provider,
        roleTitle: a.roleTitle,
        roleInstructions: a.roleInstructions,
        model: a.model || null,
        isLead: i === leadIndex,
        position: i,
      })),
    );
    return id!;
  });
}

export async function deleteTeam(userId: string, teamId: string) {
  const res = await db().delete(teams).where(and(eq(teams.id, teamId), eq(teams.userId, userId))).returning({ id: teams.id });
  return res.length > 0;
}

/** Starter teams offered to new users (not auto-created). */
export const TEAM_TEMPLATES: TeamInput[] = [
  {
    name: "Software Team",
    description: "Ship-quality code review and design.",
    agents: [
      { provider: "anthropic", roleTitle: "Lead Developer", roleInstructions: "Inspect the code deeply and find concrete defects with file references.", model: null, isLead: false },
      { provider: "openai", roleTitle: "Architect", roleInstructions: "Evaluate structure, boundaries and trade-offs. Lead the team and write the final answer.", model: null, isLead: true },
      { provider: "google", roleTitle: "Reviewer", roleInstructions: "Independently critique the others' findings and judge disagreements.", model: null, isLead: false },
      { provider: "xai", roleTitle: "Researcher", roleInstructions: "Check current best practice, library versions and known vulnerabilities on the web.", model: null, isLead: false },
    ],
  },
  {
    name: "Research Team",
    description: "Well-sourced answers with a built-in critic.",
    agents: [
      { provider: "openai", roleTitle: "Lead Reasoner", roleInstructions: "Frame the question, reason carefully, and write the final answer.", model: null, isLead: true },
      { provider: "google", roleTitle: "Researcher", roleInstructions: "Gather evidence and cite sources.", model: null, isLead: false },
      { provider: "xai", roleTitle: "Current Events", roleInstructions: "Find the most recent developments and news.", model: null, isLead: false },
      { provider: "anthropic", roleTitle: "Critic", roleInstructions: "Challenge weak claims and point out what is missing.", model: null, isLead: false },
    ],
  },
];

const LEAD_ORDER: ProviderId[] = ["openai", "anthropic", "google", "xai", "cursor"];

function keyFor(provider: ProviderId, taken: Set<string>) {
  const base = getAdapter(provider).info.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/**
 * Build the roster for a run from a saved team, an explicit selection, or
 * automatically from the user's connected providers.
 */
export async function buildRoster(
  userId: string,
  args: { teamId?: string | null; providers?: ProviderId[]; task: string; maxAgents: number; repoUrl?: string | null },
): Promise<RosterEntry[]> {
  const taken = new Set<string>();
  if (args.teamId) {
    const team = await getTeam(userId, args.teamId);
    if (!team) throw new Error("Team not found");
    return team.agents.map((a) => ({
      key: keyFor(a.provider, taken),
      provider: a.provider,
      model: a.model,
      roleTitle: a.roleTitle,
      roleInstructions: a.roleInstructions,
      isLead: a.isLead,
    }));
  }

  const connections = await listConnections(userId);
  const connected = connections.filter((c) => c.state === "connected").map((c) => c.provider);
  let chosen: ProviderId[];
  if (args.providers?.length) {
    chosen = PROVIDER_IDS.filter((p) => args.providers!.includes(p));
  } else {
    // Auto-select: rank connected providers by fit for the task.
    const t = args.task.toLowerCase();
    const wants = {
      web: /\b(latest|current|news|today|recent|market|price|research|trend)/.test(t),
      code: /\b(code|repo|repository|bug|refactor|test|api|deploy|production)/.test(t) || !!args.repoUrl,
    };
    const score = (p: ProviderId) => {
      const caps = connections.find((c) => c.provider === p)!.capabilities;
      let s = caps.includes("chat") ? 2 : 0;
      if (wants.web && caps.includes("web_research")) s += 1 + (p === "xai" || p === "google" ? 1 : 0);
      if (wants.code && caps.includes("coding")) s += 1 + (p === "anthropic" ? 1 : 0);
      if (caps.includes("repository_access")) s = args.repoUrl ? s + 2 : -1;
      return s;
    };
    chosen = connected.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a));
  }
  chosen = chosen.slice(0, args.maxAgents);
  const lead = LEAD_ORDER.find((p) => chosen.includes(p) && p !== "cursor");
  return chosen.map((p) => {
    const info = getAdapter(p).info;
    return {
      key: keyFor(p, taken),
      provider: p,
      model: null,
      roleTitle: info.defaultRole.title,
      roleInstructions: info.defaultRole.instructions,
      isLead: p === lead,
    };
  });
}
