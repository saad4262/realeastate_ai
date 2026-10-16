import { createServerClient } from '@supabase/ssr';
import type { JwtPayload } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { cookieDomainFor } from './cookie-domain';

function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  }
  return { url, key };
}

/** Who middleware verified: the token's own claims, never the cookie's unverified copy of the user. */
export type SessionIdentity = { id: string; email: string | null; label: string };

export type SessionResult = {
  response: NextResponse;
  user: SessionIdentity | null;
};

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

const HEADER_SUFFIXES = ['id', 'email', 'label'] as const;

/** Drop every session header a caller might have sent, under any prefix. */
function stripSessionHeaders(headers: Headers): void {
  for (const prefix of SESSION_HEADER_PREFIXES) {
    for (const suffix of HEADER_SUFFIXES) {
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
  opts?: { headerPrefix?: SessionHeaderPrefix },
): Promise<SessionResult> {
  const prefix = opts?.headerPrefix ?? 'x-console-user';
  const requestHeaders = forwardHeaders ?? new Headers(request.headers);

  let response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const { url, key } = publicEnv();
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

  const { data, error } = await supabase.auth.getClaims();
  const user = error ? null : identityFromClaims(data?.claims);

  if (user) {
    requestHeaders.set(`${prefix}-id`, user.id);
    if (user.email) {
      requestHeaders.set(`${prefix}-email`, encodeURIComponent(user.email));
    }
    if (user.label) {
      requestHeaders.set(`${prefix}-label`, encodeURIComponent(user.label));
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

  return { response, user };
}

/** @deprecated Prefer `updateSession` — it already returns `user`. */
export async function getMiddlewareUser(request: NextRequest) {
  const { user } = await updateSession(request);
  return user;
}
