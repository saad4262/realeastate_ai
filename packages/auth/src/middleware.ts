import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
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

export type SessionResult = {
  response: NextResponse;
  user: User | null;
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
 * Refresh Supabase session cookies and return the user from a single getUser().
 * Pass `forwardHeaders` so surface / user headers reach Server Components.
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

  const { data } = await supabase.auth.getUser();
  const user = data.user ?? null;

  if (user) {
    requestHeaders.set(`${prefix}-id`, user.id);
    if (user.email) {
      requestHeaders.set(`${prefix}-email`, encodeURIComponent(user.email));
    }
    const meta = user.user_metadata as { full_name?: string; name?: string } | undefined;
    const label = meta?.full_name ?? meta?.name ?? user.email?.split('@')[0] ?? '';
    if (label) {
      requestHeaders.set(`${prefix}-label`, encodeURIComponent(label));
    }
    // Rebuild so mutated headers are visible to the App Router
    const cookies = response.cookies.getAll();
    response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    cookies.forEach((c) => {
      response.cookies.set(c.name, c.value);
    });
  }

  return { response, user };
}

/** @deprecated Prefer `updateSession` — it already returns `user` (one getUser). */
export async function getMiddlewareUser(request: NextRequest) {
  const { user } = await updateSession(request);
  return user;
}
