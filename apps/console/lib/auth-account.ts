import { cache } from 'react';
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
