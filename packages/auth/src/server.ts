import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  }
  return { url, key };
}

function cookieOptions() {
  const domain = process.env.COOKIE_DOMAIN;
  return domain ? { domain, path: '/', sameSite: 'lax' as const } : { path: '/', sameSite: 'lax' as const };
}

/** Server Components / Route Handlers — Supabase session via cookies. */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const { url, key } = publicEnv();
  const base = cookieOptions();

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
