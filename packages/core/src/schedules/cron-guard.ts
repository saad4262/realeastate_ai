export type CronAuth = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * Is this cron request allowed to run?
 *
 * Copied in shape from apps/web/app/api/revalidate/route.ts: 503 when the
 * secret is unconfigured, 401 otherwise, a length check before the
 * comparison so it cannot be used as an oracle for the secret's length, and
 * a plain `!==` after it. This is a shared secret in a header, not a
 * password; constant time buys nothing real here.
 *
 * ## Why unconfigured refuses everything
 *
 * An open cache-buster makes the site slow. An open cron trigger spends the
 * Anthropic balance and mails a lot of people, so the failure has to be
 * closed rather than permissive.
 *
 * ## Why this lives in packages/core
 *
 * `pnpm test` runs @repo/core and @repo/ai only, so a guard written inside
 * the route handler would be a guard with no test — which is what happened
 * to the revalidate guard, still untested. § 9 wants a permission test for
 * every new endpoint, and #10 says the logic does not belong in apps/ anyway.
 *
 * ## Two header shapes
 *
 * Vercel Cron issues a GET with `Authorization: Bearer $CRON_SECRET` and
 * cannot be told to send anything else. `x-cron-secret` is for a manual
 * curl or any other pinger. Neither is a query parameter: a secret in a URL
 * lands in access logs and in a Referer.
 */
export function authoriseCronRequest(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): CronAuth {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    return { ok: false, status: 503, error: 'The scheduler is not configured' };
  }

  const bearer = headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const direct = headers.get('x-cron-secret')?.trim();

  for (const offered of [bearer, direct]) {
    if (!offered) continue;
    if (offered.length !== secret.length) continue;
    if (offered === secret) return { ok: true };
  }

  return { ok: false, status: 401, error: 'Not allowed' };
}
