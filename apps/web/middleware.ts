import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_HEADER_PREFIXES, updateSession } from '@repo/auth/middleware';

/**
 * Sessions on the consumer site.
 *
 * ## Why the matcher is the important line in this file
 *
 * `updateSession` is a `supabase.auth.getUser()` — a network round trip to
 * Supabase, on every request it runs for. The three fastest pages in this
 * repo are on this app and were measured with no middleware anywhere near
 * them: `/` 33 ms, suburb search 36 ms, radius search 32 ms
 * (ARCHITECTURE § 11). `/` is also a cached route, and a cached route that
 * does a round trip before serving is not a cached route.
 *
 * So this runs on account routes only. `/`, `/search` and `/listing/[id]`
 * have no session and must keep none. The natural next edit to this file is
 * to widen the matcher so the header can show "Sign in" on every page — do
 * not: fetch the session in the layout of the routes that need it, or render
 * the control client-side. A signed-in visitor on `/search` is worth less
 * than 36 ms.
 *
 * `/chat` is included because it is already `force-dynamic` and already
 * spends a second on a model, so one more round trip is noise there — and it
 * is what lets the page offer "save this search" and open `?alert=`.
 *
 * `/api/cron/*` is deliberately absent. A cron tick has no session, and
 * refreshing one for it is pure cost.
 *
 * ## No surface resolution
 *
 * apps/console resolves `agent` vs `agency` from the host because it serves
 * two domains from one app. This app serves one. There is nothing to resolve,
 * and #12 is not being dodged — a surface that does not vary is not a
 * hardcoded surface.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const requestHeaders = new Headers(request.headers);

  /**
   * Strip before anything else, on every path, including the paths that
   * return early below.
   *
   * `updateSession` strips these too, and this is not redundant. A forged
   * `x-console-user-id` reached a real owner's console through two paths that
   * never ran `updateSession` — one of them being `updateSession` itself
   * throwing on a missing env var, before its own delete. That was found live.
   * The same mistake on this app would hand out a consumer's saved searches.
   */
  for (const prefix of SESSION_HEADER_PREFIXES) {
    requestHeaders.delete(`${prefix}-id`);
    requestHeaders.delete(`${prefix}-email`);
    requestHeaders.delete(`${prefix}-label`);
  }

  let response: NextResponse;
  let userId: string | null = null;

  try {
    const session = await updateSession(request, requestHeaders, {
      headerPrefix: 'x-web-user',
    });
    userId = session.user?.id ?? null;
    response = session.response;
  } catch {
    /**
     * A Supabase misconfiguration must not take the public site down.
     *
     * The routes this middleware covers will behave as signed out, which is
     * the safe direction: `/alerts` sends you to `/login` and `/chat` works
     * anonymously, exactly as it does today. The headers were already
     * stripped above, so falling through here cannot leak an identity.
     */
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  /**
   * A marker saying "this response passed through the session layer".
   *
   * It exists so the matcher can be tested as behaviour instead of as a line
   * of config. The first version of that smoke check asserted only that `/`
   * does not redirect — and it stayed green with the matcher widened to every
   * route on the site, because a widened matcher does not redirect anything,
   * it just spends a Supabase round trip before serving. Absence of a
   * redirect was never the invariant; absence of the session layer is, and
   * this header is the only part of that which is visible from outside.
   */
  response.headers.set('x-web-session', userId ? 'user' : 'anon');

    const isAuthEntry =
    pathname === '/login' || pathname === '/signup' || pathname === '/forgot';

  // Signed in and standing on the sign-in page: go where you were headed.
  if (userId && isAuthEntry) {
    const next = request.nextUrl.searchParams.get('next');
    const dest = request.nextUrl.clone();
    // Only a path, never an absolute URL — `next=https://elsewhere` off a
    // login redirect is an open redirect, and this one would be reachable
    // from any emailed link.
    dest.pathname = next && next.startsWith('/') && !next.startsWith('//') ? next : '/alerts';
    dest.search = '';
    const redirect = NextResponse.redirect(dest);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c.name, c.value));
    return redirect;
  }

  const needsAccount = pathname.startsWith('/alerts') || pathname.startsWith('/account');

  if (needsAccount && !userId) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    login.searchParams.set('next', pathname);
    const redirect = NextResponse.redirect(login);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c.name, c.value));
    return redirect;
  }

  return response;
}

export const config = {
  /**
   * Account routes only. Read the note at the top of this file before adding
   * to this list — `/`, `/search` and `/listing/[id]` are excluded on purpose
   * and their absence is load-bearing.
   */
  matcher: [
    '/alerts/:path*',
    '/account/:path*',
    '/chat',
    '/login',
    '/signup',
    // `/reset` arrives straight from an emailed link and needs the session
    // the callback just created; `/forgot` is here so a signed-in visitor
    // is not offered a password reset they can do from their account.
    '/forgot',
    '/reset',
    '/auth/:path*',
    /**
     * The chat's API route, and not just its page.
     *
     * This was missing, and the page being here hid it: the UI knew you
     * were signed in while `/api/chat` did not, so the guide told a
     * signed-in visitor to sign in before it could schedule anything — and
     * every conversation silently failed to save, because `persistTurn`
     * reads the same header. Reported from a screenshot saying "i signed in
     * already???".
     *
     * The round trip is affordable precisely here: the route is already
     * `force-dynamic` and already spends a second on a model.
     *
     * `/api/cron/*` and `/api/revalidate` stay out — a machine caller has
     * no session, and refreshing one for it is pure cost.
     */
    '/api/chat',
    /**
     * The off-market property page, for the same reason.
     *
     * It offers a private offer only to a signed-in visitor, and it decides that
     * from `currentWebUser()` — which reads the header this middleware sets. Left
     * out of the matcher the header is absent, the page believes an authenticated
     * visitor is anonymous, and it shows a "sign in to make an offer" prompt to
     * somebody who already has. Exactly the `/api/chat` failure above, which was
     * reported as "i signed in already???".
     *
     * `/listing/[id]` stays out: it only needs to know which header link to draw
     * and uses the cookie sniff for that. This route needs the real answer,
     * because it gates a write.
     */
    '/property/:path*',
  ],
};
