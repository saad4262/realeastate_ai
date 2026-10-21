import { config } from 'dotenv';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { getDb } from './client';
import { platformAdmin, user } from './schema';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Make (or unmake) a platform admin (ADR 0049) — the only way one is made;
 * no screen writes `platform_admin`.
 *
 *   PLATFORM_ADMIN_EMAIL=a@b.c PLATFORM_ADMIN_PASSWORD=… pnpm --filter @repo/db db:platform-admin
 *   PLATFORM_ADMIN_EMAIL=a@b.c pnpm --filter @repo/db db:platform-admin --revoke
 *
 * Granting: the Supabase Auth account is created (email confirmed) or, if it
 * exists, its password is set to the one given; the app's `user` row mirrors
 * it (id = auth id, AGENTS.md #14); then the `platform_admin` row. The
 * password comes from the environment only and is never printed.
 *
 * Revoking removes the `platform_admin` row and leaves the account alone.
 */
async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
  const revoke = process.argv.includes('--revoke');
  const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Set PLATFORM_ADMIN_EMAIL to the admin’s email address.');
  if (!databaseUrl) throw new Error('DATABASE_URL (or DIRECT_URL) is not set.');
  const db = getDb(databaseUrl);

  if (revoke) {
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    if (!row) throw new Error(`No account with the email ${email}.`);
    const gone = await db.delete(platformAdmin).where(eq(platformAdmin.userId, row.id)).returning({ id: platformAdmin.userId });
    console.log(gone.length ? `${email} is no longer a platform admin.` : `${email} was not a platform admin.`);
    return;
  }

  if (password.length < 8) throw new Error('Set PLATFORM_ADMIN_PASSWORD (at least 8 characters).');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed to create the sign-in.');
  const auth = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;

  // The auth account: ours already knows its id if it has signed in before; otherwise create it.
  let authId: string | null = (await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1))[0]?.id ?? null;
  if (!authId) {
    const created = await auth.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Platform Admin' } });
    if (created.data.user) {
      authId = created.data.user.id;
    } else {
      // Exists in Auth but never synced to our `user` table: find it by email.
      for (let page = 1; !authId && page <= 50; page += 1) {
        const { data, error } = await auth.listUsers({ page, perPage: 200 });
        if (error) throw error;
        authId = data.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
        if (data.users.length < 200) break;
      }
      if (!authId) throw created.error ?? new Error('Could not create the sign-in.');
    }
  }
  // Set the password every time, so re-running the script is how it is changed.
  const updated = await auth.updateUserById(authId, { password, email_confirm: true });
  if (updated.error) throw updated.error;

  await db.transaction(async (tx) => {
    await tx.insert(user).values({ id: authId!, email, name: 'Platform Admin' }).onConflictDoNothing({ target: user.id });
    await tx.insert(platformAdmin).values({ userId: authId!, note: 'db:platform-admin' }).onConflictDoNothing();
  });
  console.log(`${email} is a platform admin (user ${authId}). Sign in on the admin host.`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
