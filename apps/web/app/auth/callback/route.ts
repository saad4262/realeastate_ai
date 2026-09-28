import { handleAuthCallback } from '@repo/auth/callback';

/**
 * Where a magic link lands.
 *
 * The same handler the console uses. `@supabase/ssr` pins PKCE, so the link
 * arrives carrying a one-time `code` that only the server can trade for a
 * session — pointing the email at `/login` would drop it silently. The
 * handler derives its origin from the `host` header rather than
 * `nextUrl.origin`, which is what keeps `web.lvh.me` from redirecting to
 * `localhost`.
 *
 * Nothing web-specific belongs here. The `user` row is created on the first
 * account page instead — see apps/web/lib/account.ts for why it cannot be
 * done in this request.
 */
export { handleAuthCallback as GET };
