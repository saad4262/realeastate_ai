import { NextResponse, type NextRequest } from 'next/server';
import { safeLocalPath } from '@repo/auth/safe-path';
import { createServerSupabaseClient } from '@repo/auth/server';

export const dynamic = 'force-dynamic';

/**
 * Sign out: a route handler, POST only.
 *
 * This used to be a page. A Server Component cannot write cookies: `signOut()`
 * tried to clear the session cookies, the write threw, and `setAll`'s catch
 * (meant for session refreshes) swallowed it. The session survived, /login
 * sent the still-signed-in person straight back into the console, and "Sign
 * out" did nothing. A route handler may write cookies, so here they are cleared.
 *
 * POST, because a GET sign-out is a link, and Next prefetches links in the
 * viewport. That is also why apps/web's /sign-out is POST only. The buttons
 * are forms (components/sign-out-button.tsx).
 */

/**
 * The host the browser asked for. `request.url` is the address the server
 * listens on, and redirecting there drops the cookie domain (see the same
 * function in apps/web/app/sign-out/route.ts).
 */
function originOf(request: NextRequest): string {
  const host = request.headers.get('host');
  if (!host) return request.nextUrl.origin;
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.endsWith('.lvh.me') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Relative only: `next` is user input, and an absolute value would make this an open redirect. */
function safeNext(value: unknown): string {
  return safeLocalPath(value, '/login');
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const next = safeNext(form?.get('next') ?? request.nextUrl.searchParams.get('next'));

  const supabase = await createServerSupabaseClient();
  // This browser's session only. The default, 'global', revoked every session
  // the person had — the agent desk and admin tabs on their own hosts too, which
  // then dropped to sign-in without warning once their token ran out.
  // `scope=global` is "Sign out of all devices" (PLATFORM-PLAN 1.22): every session this person has, everywhere.
  await supabase.auth.signOut({ scope: form?.get('scope') === 'global' ? 'global' : 'local' });

  // 303 turns the POST into a GET at the destination.
  const response = NextResponse.redirect(`${originOf(request)}${next}`, { status: 303 });
  // signOut() clears the session cookie under COOKIE_DOMAIN, but the sign-in form's browser client wrote it
  // host-only: a different cookie, which stayed, and the person was still signed in. Clear that one too.
  for (const c of request.cookies.getAll()) {
    if (c.name.startsWith('sb-')) response.headers.append('Set-Cookie', `${c.name}=; Path=/; Max-Age=0; SameSite=Lax`);
  }
  return response;
}

/** An old link or a prefetch: never signs anyone out, just goes home. */
export async function GET(request: NextRequest) {
  return NextResponse.redirect(`${originOf(request)}/`, { status: 303 });
}
