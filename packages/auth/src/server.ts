import { createServerClient } from '@supabase/ssr';
import { cookies, headers } from 'next/headers';
import { sessionCookieOptions } from './cookie-domain';

function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  }
  return { url, key };
}

/** Server Components / Route Handlers — Supabase session via cookies. */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const { url, key } = publicEnv();
  /**
   * Host-aware. A `.lvh.me` domain on a `localhost` request is a cookie
   * the browser throws away without telling anyone — see ./cookie-domain.
   */
  const base = sessionCookieOptions((await headers()).get('host'));

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, { ...options, ...base });
          });
        } catch {
          // Called from a Server Component — middleware refreshes sessions.
        }
      },
    },
  });
}

export async function getSession() {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function requireUser() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error('Unauthorized');
  }
  return data.user;
}
