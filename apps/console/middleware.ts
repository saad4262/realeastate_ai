import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@repo/auth/middleware';

export type ConsoleSurface = 'agent' | 'agency';

export function resolveSurface(host: string): ConsoleSurface {
  const hostname = host.split(':')[0]?.toLowerCase() ?? '';
  if (hostname.startsWith('agency.') || hostname === 'agency.lvh.me') {
    return 'agency';
  }
  return 'agent';
}

function withSurface(
  response: NextResponse,
  surface: ConsoleSurface,
  cookieDomain: string | undefined,
) {
  response.headers.set('x-console-surface', surface);
  response.cookies.set('console-surface', surface, {
    path: '/',
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });
  return response;
}

function homePath(surface: ConsoleSurface) {
  return surface === 'agency' ? '/overview' : '/listings';
}

export async function middleware(request: NextRequest) {
  const host = request.headers.get('host') ?? 'agents.lvh.me';
  const surface = resolveSurface(host);
  const { pathname } = request.nextUrl;
  const cookieDomain = process.env.COOKIE_DOMAIN;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-console-surface', surface);

  const isAuthEntry =
    pathname.startsWith('/login') || pathname.startsWith('/signup');

  const isPublic =
    isAuthEntry ||
    pathname.startsWith('/reset') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/sign-out');

  const uiPreview = process.env.NEXT_PUBLIC_UI_PREVIEW === '1';

  // Escape hatch for UI mocks only — keep off for real sessions
  if (uiPreview) {
    let response = NextResponse.next({ request: { headers: requestHeaders } });
    response = withSurface(response, surface, cookieDomain);

    if (pathname === '/') {
      const dest = request.nextUrl.clone();
      dest.pathname = homePath(surface);
      const redirect = NextResponse.redirect(dest);
      return withSurface(redirect, surface, cookieDomain);
    }
    return response;
  }

  // Single Supabase getUser via updateSession — never also call getMiddlewareUser
  let response: NextResponse;
  let userId: string | null = null;

  try {
    const session = await updateSession(request, requestHeaders);
    userId = session.user?.id ?? null;
    response = withSurface(session.response, surface, cookieDomain);
  } catch {
    response = withSurface(
      NextResponse.next({ request: { headers: requestHeaders } }),
      surface,
      cookieDomain,
    );
  }

  // An invite link must reach the page even with a session already present.
  // Redirecting here dropped ?invite= along with the rest of the query, so an
  // agent who was signed in — or an owner testing the link — landed on the
  // dashboard and the invite was silently lost.
  const carriesInvite = request.nextUrl.searchParams.has('invite');

  // ?error= means a page just turned this session away and sent it here to be
  // told why. Bouncing it back to that page is an infinite redirect: the
  // layout refuses again, redirects here again, and the reason is never read.
  const carriesError = request.nextUrl.searchParams.has('error');

  // Signed-in users should not linger on login/signup
  if (userId && isAuthEntry && !carriesInvite && !carriesError) {
    const dest = request.nextUrl.clone();
    const next = request.nextUrl.searchParams.get('next');
    dest.pathname =
      next && next.startsWith('/') ? next : homePath(surface);
    dest.search = '';
    const redirect = NextResponse.redirect(dest);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c.name, c.value));
    return withSurface(redirect, surface, cookieDomain);
  }

  if (!isPublic && !userId) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.searchParams.set(
      'next',
      pathname === '/' ? homePath(surface) : pathname,
    );
    const redirect = NextResponse.redirect(login);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c.name, c.value));
    return withSurface(redirect, surface, cookieDomain);
  }

  if (pathname === '/') {
    const dest = request.nextUrl.clone();
    dest.pathname = homePath(surface);
    const redirect = NextResponse.redirect(dest);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c.name, c.value));
    return withSurface(redirect, surface, cookieDomain);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
