import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError, type JwtPayload } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { cookieDomainFor } from './cookie-domain';
import { SESSION_HEADER_SUFFIXES, sessionHeaderSecret, signIdentity } from './session-header';

function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  }
  // No key to sign the forwarded identity: refuse like a missing URL (the apps then treat everyone as signed out).
  const secret = sessionHeaderSecret();
  if (!secret) throw new Error('Missing SESSION_HEADER_SECRET or SUPABASE_SERVICE_ROLE_KEY');
  return { url, key, secret };
}

/** Who middleware verified: the token's own claims, never the cookie's unverified copy of the user. */
export type SessionIdentity = { id: string; email: string | null; label: string };

export type SessionResult = {
  response: NextResponse;
  user: SessionIdentity | null;
  /**
   * The Auth server could not be reached (network error, 5xx, or no answer in time), so the session was
   * neither confirmed nor refused. `user` is null and the session cookie is left as it was: the caller
   * answers 503 (`authUnavailableResponse`) instead of sending a signed-in person to /login (PLATFORM-PLAN 1.1).
   */
  unavailable: boolean;
};

/**
 * How long a request waits for the Auth server. auth-js retries a failed refresh with backoff for up to
 * 30 s, which during an outage would hold every request that long; past this, the answer is 503.
 */
export const AUTH_WAIT_MS = 4_000;

const TIMED_OUT = Symbol('auth timed out');

/**
 * Every header name in this codebase that means "middleware verified a
 * session". All of them are stripped on every request, in every app.
 *
 * One list, because the danger is the one that is forgotten. apps/console
 * reads `x-console-user-id` and apps/web reads `x-web-user-id`, and neither
 * app should have to know the other's name in order to refuse it — a request
 * arriving at the consumer site carrying a console header has to die
 * somewhere, and the honest place is here rather than in whichever app
 * remembered.
 */
export const SESSION_HEADER_PREFIXES = ['x-console-user', 'x-web-user'] as const;

export type SessionHeaderPrefix = (typeof SESSION_HEADER_PREFIXES)[number];

/** Drop every session header a caller might have sent, under any prefix. */
export function stripSessionHeaders(headers: Headers): void {
  for (const prefix of SESSION_HEADER_PREFIXES) {
    for (const suffix of SESSION_HEADER_SUFFIXES) {
      headers.delete(`${prefix}-${suffix}`);
    }
  }
}

/**
 * The identity in a verified access token, or null if it names nobody.
 *
 * `sub` is auth.users.id, which is the app's user.id (CLAUDE.md #14). The label
 * is what the shell greets with: the name given at sign-up, else the address's
 * local part. Exported for its unit test.
 */
export function identityFromClaims(claims: JwtPayload | null | undefined): SessionIdentity | null {
  const id = claims?.sub;
  if (typeof id !== 'string' || !id) return null;
  const email = typeof claims?.email === 'string' && claims.email ? claims.email : null;
  const meta = claims?.user_metadata as { full_name?: unknown; name?: unknown } | undefined;
  const named = [meta?.full_name, meta?.name].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return { id, email, label: named ?? email?.split('@')[0] ?? '' };
}

/**
 * Refresh Supabase session cookies and return who the verified token names.
 * Pass `forwardHeaders` so surface / user headers reach Server Components.
 *
 * `getClaims()`, not `getUser()` (ADR 0046). getUser asks the Auth server on
 * every request — every page, RSC navigation, prefetch and poll — and
 * middleware runs at the edge near the visitor, not beside the database, so
 * that was a long round trip before anything else began. getClaims checks the
 * access token's ES256 signature here, against the project's public keys
 * (fetched once and cached for ten minutes by auth-js), and still refreshes an
 * expired session through getSession. With a symmetric key it falls back to
 * getUser by itself, so it is never weaker than before. What it cannot see is a
 * session revoked elsewhere until the token expires; every console page and
 * action loads the member from our own database (loadActor → can()), which is
 * where a removed member is refused.
 *
 * `headerPrefix` chooses which name the verified identity is written under.
 * It defaults to the console's, so the console's call site is unchanged.
 */
export async function updateSession(
  request: NextRequest,
  forwardHeaders?: Headers,
  opts?: { headerPrefix?: SessionHeaderPrefix; authWaitMs?: number },
): Promise<SessionResult> {
  const prefix = opts?.headerPrefix ?? 'x-console-user';
  const requestHeaders = forwardHeaders ?? new Headers(request.headers);

  let response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const { url, key, secret } = publicEnv();
  // Host-aware: `.lvh.me` on a localhost request is discarded silently.
  const domain = cookieDomainFor(request.headers.get('host'));

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({
          request: { headers: requestHeaders },
        });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, {
            ...options,
            ...(domain ? { domain, path: '/' } : { path: '/' }),
          });
        });
      },
    },
  });

  // These headers are middleware's statement that it verified the session, so
  // anything the client sent under the same names is dropped first. Setting
  // them only when a user exists left a caller-supplied id in place for an
  // anonymous request — harmless while nothing read them, not once anything does.
  // Every prefix is dropped, not just the one being written: a forged
  // x-console-user-id must not survive a request to the consumer app either.
  stripSessionHeaders(requestHeaders);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    supabase.auth.getClaims(),
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), opts?.authWaitMs ?? AUTH_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (outcome === TIMED_OUT || isAuthRetryableFetchError(outcome.error)) {
    // A fresh response: whatever the refresh attempt queued (a cleared or half-written cookie) never reaches
    // the browser, so the person is still signed in when Auth answers again.
    return { response: NextResponse.next({ request: { headers: requestHeaders } }), user: null, unavailable: true };
  }
  const { data, error } = outcome;
  const user = error ? null : identityFromClaims(data?.claims);

  if (user) {
    // Signed (PLATFORM-PLAN 1.2): readers believe these only with a valid signature and expiry.
    for (const [name, value] of Object.entries((await signIdentity(prefix, user, Date.now(), secret))!)) {
      requestHeaders.set(name, value);
    }
    // Rebuild so mutated headers are visible to the App Router
    const cookies = response.cookies.getAll();
    response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    // The WHOLE cookie, not name and value. Copying only those two dropped
    // Domain, Max-Age and SameSite from every refreshed session cookie: the
    // browser then held a host-only copy beside the old `.lvh.me` one, the
    // other app kept refreshing with the rotated-out token, and Supabase's
    // reuse detection revoked the session — "it keeps asking me to sign in".
    cookies.forEach((c) => {
      response.cookies.set(c);
    });
  }

  return { response, user, unavailable: false };
}

/**
 * The answer while Auth is down: 503 with Retry-After, never cached, no cookie touched. JSON in the API error
 * shape for API routes and Server Actions (their callers parse it); a small page for everything else.
 */
export function authUnavailableResponse(request: NextRequest): NextResponse {
  const message = 'Sign-in is briefly unavailable. Please try again in a few seconds.';
  const headers = { 'retry-after': '15', 'cache-control': 'no-store' };
  const wantsJson = request.nextUrl.pathname.startsWith('/api/') || request.headers.has('next-action');
  if (wantsJson) {
    return NextResponse.json({ error: { code: 'auth_unavailable', message } }, { status: 503, headers });
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="15"><title>Back in a moment</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Back in a moment</h1><p>${message} You are still signed in; this page reloads by itself.</p></body></html>`;
  return new NextResponse(html, { status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
}

/** @deprecated Prefer `updateSession` — it already returns `user`. */
export async function getMiddlewareUser(request: NextRequest) {
  const { user } = await updateSession(request);
  return user;
}
