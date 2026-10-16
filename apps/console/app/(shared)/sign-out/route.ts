import { NextResponse, type NextRequest } from 'next/server';
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
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/login';
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const next = safeNext(form?.get('next') ?? request.nextUrl.searchParams.get('next'));

  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();

  // 303 turns the POST into a GET at the destination.
  return NextResponse.redirect(`${originOf(request)}${next}`, { status: 303 });
}

/** An old link or a prefetch: never signs anyone out, just goes home. */
export async function GET(request: NextRequest) {
  return NextResponse.redirect(`${originOf(request)}/`, { status: 303 });
}
