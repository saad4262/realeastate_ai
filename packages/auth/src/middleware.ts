import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';

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
 * Refresh Supabase session cookies and return the user from a single getUser().
 * Pass `forwardHeaders` so surface / user headers reach Server Components.
 */
export async function updateSession(
  request: NextRequest,
  forwardHeaders?: Headers,
): Promise<SessionResult> {
  const requestHeaders = forwardHeaders ?? new Headers(request.headers);

  let response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const { url, key } = publicEnv();
  const domain = process.env.COOKIE_DOMAIN;

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
  requestHeaders.delete('x-console-user-id');
  requestHeaders.delete('x-console-user-label');
  requestHeaders.delete('x-console-user-email');

  const { data } = await supabase.auth.getUser();
  const user = data.user ?? null;

  if (user) {
    requestHeaders.set('x-console-user-id', user.id);
    if (user.email) {
      requestHeaders.set('x-console-user-email', encodeURIComponent(user.email));
    }
    const meta = user.user_metadata as { full_name?: string; name?: string } | undefined;
    const label = meta?.full_name ?? meta?.name ?? user.email?.split('@')[0] ?? '';
    if (label) {
      requestHeaders.set('x-console-user-label', encodeURIComponent(label));
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
