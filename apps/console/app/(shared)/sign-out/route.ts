import { NextResponse, type NextRequest } from 'next/server';
import { safeLocalPath } from '@repo/auth/safe-path';
import { signOutResponse } from '@repo/auth/sign-out';

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

  // This browser's session only, unless `scope=global`: "Sign out of all devices" (PLATFORM-PLAN 1.22). The
  // default, 'global', used to end every session the person had — the agent desk and admin tabs too.
  // Both copies of the session cookie go (host-only and COOKIE_DOMAIN): see @repo/auth/sign-out.
  // 303 turns the POST into a GET at the destination.
  return signOutResponse(request, form?.get('scope') === 'global' ? 'global' : 'local', `${originOf(request)}${next}`);
}

/** An old link or a prefetch: never signs anyone out, just goes home. */
export async function GET(request: NextRequest) {
  return NextResponse.redirect(`${originOf(request)}/`, { status: 303 });
}
