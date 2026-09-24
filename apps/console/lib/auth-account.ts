import { cache } from 'react';
import { headers } from 'next/headers';
import { createServerSupabaseClient } from '@repo/auth/server';

/** The signed-in Supabase account, read from the session cookie — never from client input. */
export type AuthAccount = {
  userId: string;
  email: string;
  name: string | null;
};

function metaName(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const full = meta.full_name;
  const name = meta.name;
  if (typeof full === 'string' && full.trim()) return full.trim();
  if (typeof name === 'string' && name.trim()) return name.trim();
  return null;
}

/** Cached per request so several actions in one render share a single getUser(). */
export const getAuthAccount = cache(async (): Promise<AuthAccount | null> => {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;

  return {
    userId: data.user.id,
    email: data.user.email.toLowerCase(),
    name: metaName(data.user.user_metadata as Record<string, unknown> | undefined),
  };
});

export async function requireAuthAccount(): Promise<AuthAccount> {
  const account = await getAuthAccount();
  if (!account) {
    throw new Error('Not signed in');
  }
  return account;
}

/**
 * The signed-in user's id, for a Server Action.
 *
 * Middleware already calls supabase.auth.getUser() on every request that
 * reaches this app — server action POSTs included, since the matcher covers
 * everything but _next/static, _next/image and favicon — and forwards the
 * verified id as a header it strips from the caller's own request first.
 * Reading that header is the same thing every page in the console already
 * does through requireConsoleSession.
 *
 * The actions were not doing it. Each one called getAuthAccount() instead,
 * which is a second round trip to the auth service for an answer this request
 * already has — measured at roughly 520 ms, and paid on every publish,
 * withdraw, delete, edit, address keystroke and pin drag.
 *
 * This does not weaken anything. Middleware performs the same real token
 * verification; authorisation is still loadListingActor + can(), which query
 * by this id and cannot return another agency's rows.
 *
 * The fallback is deliberate. If the header is missing for a reason that is
 * not "signed out" — middleware skipped, a runtime that does not forward
 * rewritten headers — the full check still runs, so the worst case is the
 * latency we had before rather than a console that refuses every action. It
 * fails closed either way: no header and no session is still not signed in.
 */
export const actionUserId = cache(async (): Promise<string | null> => {
  const verified = (await headers()).get('x-console-user-id');
  if (verified) return verified;

  const account = await getAuthAccount();
  if (account && process.env.NODE_ENV === 'development') {
    // Worth knowing: it means the fast path is not being taken and every
    // action is paying for the round trip this was written to remove.
    console.warn(
      '[auth] x-console-user-id was absent but a session exists — ' +
        'middleware headers are not reaching this Server Action.',
    );
  }
  return account?.userId ?? null;
});

/** Same, for the callers that cannot proceed without one. */
export async function requireActionUserId(): Promise<string> {
  const userId = await actionUserId();
  if (!userId) {
    throw new Error('Not signed in');
  }
  return userId;
}
