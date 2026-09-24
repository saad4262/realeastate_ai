import { createBrowserClient } from '@supabase/ssr';

function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  }
  return { url, key };
}

/** Browser Supabase client (publishable key only). */
export function createBrowserSupabaseClient() {
  const { url, key } = publicEnv();
  return createBrowserClient(url, key);
}
