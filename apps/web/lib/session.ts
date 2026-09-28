import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Who is signed in, according to middleware.
 *
 * Reads the verified header rather than calling `getUser()` again. That
 * re-check measured ~520 ms on every console Server Action and is the whole
 * subject of docs/adr/0008 — the header is the session, because middleware
 * strips any inbound copy before setting its own.
 *
 * Only meaningful on routes the middleware matcher covers. On `/`, `/search`
 * and `/listing/[id]` it always returns null, because no session is read
 * there on purpose — see the note in apps/web/middleware.ts. Calling this
 * from one of those pages does not make it anonymous; it makes it *wrong*,
 * silently, for a signed-in visitor. If a public page ever needs to know,
 * widen the matcher deliberately and pay the round trip.
 */
export type WebUser = {
  id: string;
  email: string | null;
  label: string | null;
};

function decode(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    // Middleware encoded it; a value that will not decode did not come from
    // there, so it is not an identity.
    return null;
  }
}

export async function currentWebUser(): Promise<WebUser | null> {
  const h = await headers();
  const id = h.get('x-web-user-id');
  if (!id) return null;

  return {
    id,
    email: decode(h.get('x-web-user-email')),
    label: decode(h.get('x-web-user-label')),
  };
}

/**
 * The same, for a route that cannot render without one.
 *
 * Middleware already redirects an anonymous visitor away from `/alerts` and
 * `/account`, so reaching this is either a matcher gap or a route that
 * forgot to add itself. Redirecting rather than throwing means the gap costs
 * a login prompt instead of a 500 — and the `next` parameter means they land
 * back where they were aiming.
 */
export async function requireWebUser(nextPath: string): Promise<WebUser> {
  const user = await currentWebUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}

/**
 * Is there probably a session? A display hint, and nothing more.
 *
 * `/`, `/search` and `/listing/[id]` are outside the middleware matcher on
 * purpose, so `currentWebUser()` is always null there — see
 * apps/web/middleware.ts. That leaves those pages unable to tell whether to
 * render "Save this search" or "Sign in to save", and the fix must not be to
 * widen the matcher: that is a Supabase round trip in front of a 33 ms
 * cached page.
 *
 * So this looks for the presence of the auth cookie and does not verify it.
 * A forged cookie makes a button appear; pressing it reaches a Server Action
 * that reads the real session and refuses. That is § 9's "hiding a button is
 * a courtesy — the server refuses regardless", used the way round it was
 * meant: never to decide anything, only to choose which of two honest things
 * to show.
 *
 * It must never gate data, an action, or anything a person could mistake for
 * proof that they are signed in.
 */
export async function looksSignedIn(): Promise<boolean> {
  const jar = await cookies();
  // @supabase/ssr names its cookies `sb-<project-ref>-auth-token`, possibly
  // chunked with a `.0` / `.1` suffix when the JWT is large.
  return jar.getAll().some((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
}
