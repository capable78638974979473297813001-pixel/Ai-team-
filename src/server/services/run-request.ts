import { z } from "zod";
import { isProviderId } from "../providers/registry";

export const runRequest = z.object({
  prompt: z.string().trim().min(1, "Tell the team what to do").max(20_000, "That request is too long"),
  teamId: z.string().uuid().nullable().optional(),
  providers: z.array(z.string().refine(isProviderId)).max(8).optional(),
  repoUrl: z
    .string()
    .trim()
    .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/, "Use a GitHub repository URL like https://github.com/owner/repo")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  allowPullRequests: z.boolean().default(false),
  contextTaskIds: z.array(z.string().uuid()).max(5).default([]),
  limits: z
    .object({
      maxRounds: z.number().int().optional(),
      maxAgents: z.number().int().optional(),
      maxCalls: z.number().int().optional(),
      maxRuntimeMs: z.number().int().optional(),
      maxCostUsd: z.number().nullable().optional(),
    })
    .optional(),
});
export type RunRequest = z.infer<typeof runRequest>;
