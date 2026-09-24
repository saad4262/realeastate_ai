import { sql } from 'drizzle-orm';
import { user, type Db } from '@repo/db';

/**
 * Mirror of a Supabase `auth.users` row into `public.user`.
 * `id` is always the auth user id — never generated here (ADR 0004/0006).
 */
export type AppUserInput = {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
};

/**
 * Idempotently mirror the signed-in auth user into `public.user`.
 * Existing non-null values win over nulls, so a later sign-in never wipes a profile.
 */
export async function ensureAppUser(
  db: Db,
  input: AppUserInput,
): Promise<{ userId: string }> {
  const email = input.email.trim().toLowerCase();

  await db
    .insert(user)
    .values({
      id: input.id,
      email,
      name: input.name ?? null,
      phone: input.phone ?? null,
      avatarUrl: input.avatarUrl ?? null,
    })
    .onConflictDoUpdate({
      target: user.id,
      set: {
        email,
        name: sql`coalesce(excluded.name, ${user.name})`,
        phone: sql`coalesce(excluded.phone, ${user.phone})`,
        avatarUrl: sql`coalesce(excluded.avatar_url, ${user.avatarUrl})`,
        updatedAt: sql`now()`,
      },
    });

  return { userId: input.id };
}
