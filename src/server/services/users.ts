import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { users, type RunLimits } from "../db/schema";
import { clampLimits } from "../orchestrator/budget";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../security/password";

export const signupInput = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(254),
  password: z.string().min(10, "Use at least 10 characters").max(200),
});

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export async function createUser(input: z.infer<typeof signupInput>) {
  const data = signupInput.parse(input);
  const existing = await db().select({ id: users.id }).from(users).where(eq(users.email, data.email));
  if (existing.length) return null;
  const [row] = await db()
    .insert(users)
    .values({ email: data.email, name: data.name, passwordHash: await hashPassword(data.password) })
    .onConflictDoNothing()
    .returning({ id: users.id, email: users.email, name: users.name });
  return row ?? null;
}

export async function authenticate(email: string, password: string) {
  const [row] = await db().select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  // Always run the hash to keep timing uniform whether or not the user exists.
  const ok = await verifyPassword(password, row?.passwordHash ?? DUMMY_PASSWORD_HASH);
  return ok && row ? { id: row.id, email: row.email, name: row.name } : null;
}

export async function getUserLimits(userId: string): Promise<RunLimits> {
  const [row] = await db().select({ settings: users.settings }).from(users).where(eq(users.id, userId));
  return clampLimits(row?.settings.limits);
}

export async function updateUserLimits(userId: string, limits: Partial<RunLimits>) {
  const clamped = clampLimits(limits);
  await db().update(users).set({ settings: { limits: clamped }, updatedAt: new Date() }).where(eq(users.id, userId));
  return clamped;
}
