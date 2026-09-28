/**
 * Which domain a session cookie may claim, for THIS request's host.
 *
 * `COOKIE_DOMAIN` is `.lvh.me` so one sign-in covers `web.lvh.me`,
 * `agency.lvh.me` and `agents.lvh.me` — that is the whole point of it
 * (ADR 0003). But it was applied unconditionally, and RFC 6265 says a
 * cookie's `Domain` must domain-match the host it is being set on.
 * `.lvh.me` does not match `localhost`, so on `http://localhost:3000` the
 * browser **silently discards every session cookie**: sign-in appears to
 * work, the redirect happens, and you are never signed in. Nothing logs,
 * because rejecting a cookie is the browser's decision and the server
 * never hears about it.
 *
 * So the domain is now applied only when the host actually belongs to it,
 * and omitted otherwise — which yields an ordinary host-only cookie, the
 * right answer for `localhost` and for any preview host that is not under
 * the configured domain.
 */
export function cookieDomainFor(host: string | null | undefined): string | undefined {
  const configured = process.env.COOKIE_DOMAIN?.trim();
  if (!configured) return undefined;

  const hostname = (host ?? '').split(':')[0]?.toLowerCase();
  if (!hostname) return undefined;

  // ".lvh.me" covers "lvh.me" and anything under it, and nothing else.
  const bare = configured.replace(/^\./, '').toLowerCase();
  if (hostname === bare || hostname.endsWith(`.${bare}`)) return configured;

  return undefined;
}

/** Cookie options for this request's host. */
export function sessionCookieOptions(host: string | null | undefined) {
  const domain = cookieDomainFor(host);
  return domain
    ? { domain, path: '/', sameSite: 'lax' as const }
    : { path: '/', sameSite: 'lax' as const };
}
