import { createServerClient } from '@supabase/ssr';
import { cookieDomainFor } from './cookie-domain';

/**
 * Sign out, for a route handler: Supabase ends the session (this browser's, or every session with `global`), and the
 * response deletes each `sb-` cookie in BOTH forms the browser may hold: host-only (written by the sign-in form's
 * browser client) and under COOKIE_DOMAIN (written by middleware when it refreshes the session).
 *
 * Not through next/headers' cookie store: Next keeps one Set-Cookie per name, so the two deletions became one and
 * the other copy kept the person signed in. Raw headers carry both.
 */
export async function signOutResponse(
  request: { headers: Headers; cookies: { getAll(): { name: string; value: string }[] } },
  scope: 'local' | 'global',
  location: string,
): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url && key) {
    // Its own cookie writes are dropped: the deletions below are the response's.
    const supabase = createServerClient(url, key, { cookies: { getAll: () => request.cookies.getAll(), setAll: () => undefined } });
    await supabase.auth.signOut({ scope }).catch(() => undefined);
  }
  return withDeletions(location, request);
}

function withDeletions(location: string, request: { headers: Headers; cookies: { getAll(): { name: string }[] } }): Response {
  const headers = new Headers({ location });
  const domain = cookieDomainFor(request.headers.get('host'));
  for (const c of request.cookies.getAll()) {
    if (!c.name.startsWith('sb-')) continue;
    headers.append('set-cookie', `${c.name}=; Path=/; Max-Age=0; SameSite=Lax`);
    if (domain) headers.append('set-cookie', `${c.name}=; Path=/; Max-Age=0; Domain=${domain}; SameSite=Lax`);
  }
  return new Response(null, { status: 303, headers });
}
