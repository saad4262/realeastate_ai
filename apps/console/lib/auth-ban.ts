import { createClient } from '@supabase/supabase-js';
import type { AuthBan } from '@repo/core/platform';

/**
 * Supabase's side of blocking a site user (ADR 0052): a ban refuses their
 * sign-in and their next token refresh. Needs the service-role key, which
 * this server already holds for invites; without it there is no ban and the
 * block rests on the database flag alone (the caller is told).
 */
export function authBanFromEnv(env: NodeJS.ProcessEnv = process.env): AuthBan | undefined {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return undefined;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
  return {
    async setBanned(userId, banned) {
      // ~100 years is Supabase's "until undone"; 'none' lifts it.
      const { error } = await admin.updateUserById(userId, { ban_duration: banned ? '876000h' : 'none' });
      if (error) throw error;
    },
  };
}
