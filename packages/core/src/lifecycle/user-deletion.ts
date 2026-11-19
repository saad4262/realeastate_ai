import { eq, sql } from 'drizzle-orm';
import { inspectionPhoto, user, type Db } from '@repo/db';

/**
 * PLATFORM-PLAN 5.12: a public user deletes their own account. Their own data goes with the row (shortlist, watches,
 * inspection notes and photos, chats, buyer profile: every such table cascades on `user`); an agency's records of
 * them (an enquiry, a contact) stay with the agency, unlinked. Someone who works at an agency, or a platform admin,
 * is refused: they leave through the agency (ADR 0030) or the platform first.
 */
export class AccountDeletionError extends Error {
  constructor(readonly code: 'not_found' | 'works_at_agency' | 'platform_admin', message: string) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

export type AccountDeletionDeps = {
  /** Supabase Auth's account, deleted first so nobody signs in to a half-deleted one. */
  deleteAuthUser(userId: string): Promise<void>;
  /** The inspection photos' files (private bucket); false = some remain, for a re-run. */
  deletePhotos(keys: readonly string[]): Promise<boolean>;
};

export async function deleteOwnAccount(db: Db, who: { userId: string }, deps: AccountDeletionDeps): Promise<{ photos: number; photosDeleted: boolean }> {
  const [row] = await db.execute<{ found: boolean; member: boolean; admin: boolean }>(sql`
    select exists (select 1 from "user" where id = ${who.userId}) as found,
           exists (select 1 from membership where user_id = ${who.userId}) as member,
           exists (select 1 from platform_admin where user_id = ${who.userId}) as admin`);
  if (!row?.found) throw new AccountDeletionError('not_found', 'No such account');
  if (row.member) throw new AccountDeletionError('works_at_agency', 'This account works at an agency: the agency removes it first');
  if (row.admin) throw new AccountDeletionError('platform_admin', 'A platform admin account is removed by another admin first');
  const keys = (await db.select({ key: inspectionPhoto.storageKey }).from(inspectionPhoto).where(eq(inspectionPhoto.userId, who.userId))).map((r) => r.key);
  await deps.deleteAuthUser(who.userId);
  // One statement: the cascades are the database's, all or nothing.
  await db.delete(user).where(eq(user.id, who.userId));
  const photosDeleted = keys.length ? await deps.deletePhotos(keys).catch(() => false) : true;
  return { photos: keys.length, photosDeleted };
}

/** Supabase Auth's admin API (service-role key), for scripts and routes that hold it. */
export function authAdminFromEnv(env: NodeJS.ProcessEnv = process.env): AccountDeletionDeps['deleteAuthUser'] | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return async (userId) => {
    const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    // 404: already gone (a re-run); anything else stops before the row is touched.
    if (!res.ok && res.status !== 404) throw new Error(`Auth refused the delete (${res.status})`);
  };
}
