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
  try {
    await upsert(db, input, email);
  } catch (err) {
    // `user.email` is unique. A row already holding this address under ANOTHER
    // id is what an auth account leaves behind when it is deleted: the email is
    // free in Supabase again, and a new sign-up with it could never get its
    // row — every account page failed for it. Free the address from a row
    // whose auth account no longer exists, and try once more. Its data stays
    // on the old id: a new account with the same address is not entitled to
    // the old one's saved searches or messages.
    if (!isEmailConflict(err) || !(await releaseOrphanedEmail(db, email, input.id))) throw err;
    await upsert(db, input, email);
  }
  return { userId: input.id };
}

function isEmailConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string; constraint?: string; message?: string };
  return e?.code === '23505' && /email/.test(`${e.constraint_name ?? e.constraint ?? ''} ${e.message ?? ''}`);
}

/** Rename the address off a row whose auth account is gone. True when one was freed. */
async function releaseOrphanedEmail(db: Db, email: string, newId: string): Promise<boolean> {
  const freed = await db.execute<{ id: string }>(sql`
    update "user" u
    set email = 'orphaned+' || u.id || '@invalid.local', updated_at = now()
    where lower(u.email) = ${email}
      and u.id <> ${newId}
      and not exists (select 1 from auth.users a where a.id = u.id)
    returning u.id
  `);
  return freed.length > 0;
}

async function upsert(db: Db, input: AppUserInput, email: string): Promise<void> {
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
}
