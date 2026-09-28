import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@repo/auth/server';

export const dynamic = 'force-dynamic';

/**
 * POST only, deliberately.
 *
 * A GET sign-out is a link, and a link is something a prefetcher, a crawler
 * or an image tag can follow on the visitor's behalf. Next prefetches links
 * in the viewport by default, so a GET version of this would sign people out
 * for scrolling past the button.
 */
/**
 * `request.url` reports the address the server is listening on, not the host
 * the browser asked for.
 *
 * Verified: a POST to `web.lvh.me:3055/sign-out` redirected to
 * `localhost:3055/`. On one host that is merely wrong; it also throws away the
 * cookie domain, so the session cookie set on `.lvh.me` is no longer in scope
 * at the destination and the visitor can appear signed in again. This is the
 * same trap `originOf` in @repo/auth/callback exists for, and the host header
 * is the same source middleware trusts.
 */
function originOf(request: NextRequest): string {
  const host = request.headers.get('host');
  if (!host) return request.nextUrl.origin;
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.endsWith('.lvh.me') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();

  // Back to the public site, not to /login — signing out is not a prelude to
  // signing in, and bouncing someone to a sign-in form is the opposite of
  // what they just asked for.
  return NextResponse.redirect(`${originOf(request)}/`, {
    // 303: turn the POST into a GET for the redirect, so the browser does not
    // re-post to the destination.
    status: 303,
  });
}
