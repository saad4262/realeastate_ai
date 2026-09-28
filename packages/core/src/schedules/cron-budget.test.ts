import { describe, expect, it } from 'vitest';
import { decideBudget } from './budget';
import { authoriseCronRequest } from './cron-guard';

const SECRET = 'a-cron-secret-value';
const env = (over: Record<string, string | undefined> = {}) =>
  ({ CRON_SECRET: SECRET, ...over }) as NodeJS.ProcessEnv;

/**
 * The permission test § 9 requires for a new endpoint.
 *
 * It lives here rather than beside the route because `pnpm test` runs
 * @repo/core and @repo/ai only — a guard written inside the route handler
 * would be a guard with no test, which is exactly what happened to the
 * revalidate guard this one is modelled on.
 */
describe('authoriseCronRequest', () => {
  it('refuses everything when no secret is configured', () => {
    const result = authoriseCronRequest(
      new Headers({ authorization: `Bearer ${SECRET}` }),
      env({ CRON_SECRET: undefined }),
    );

    // 503, not 401: the endpoint is not deployed, rather than the caller
    // being wrong. An open trigger here spends money and mails people.
    expect(result).toEqual({ ok: false, status: 503, error: 'The scheduler is not configured' });
  });

  it('refuses a request with no credential at all', () => {
    expect(authoriseCronRequest(new Headers(), env())).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts the Bearer form Vercel Cron sends', () => {
    expect(
      authoriseCronRequest(new Headers({ authorization: `Bearer ${SECRET}` }), env()),
    ).toEqual({ ok: true });
  });

  it('accepts the header form a manual curl sends', () => {
    expect(authoriseCronRequest(new Headers({ 'x-cron-secret': SECRET }), env())).toEqual({
      ok: true,
    });
  });

  it('refuses a value of the right length but the wrong contents', () => {
    const wrong = 'b'.repeat(SECRET.length);
    expect(wrong).toHaveLength(SECRET.length);
    expect(authoriseCronRequest(new Headers({ 'x-cron-secret': wrong }), env())).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('refuses a prefix of the real secret', () => {
    expect(
      authoriseCronRequest(new Headers({ 'x-cron-secret': SECRET.slice(0, -1) }), env()),
    ).toMatchObject({ ok: false, status: 401 });
  });

  /**
   * A secret in a query string lands in access logs and in the Referer of
   * every link on whatever page it reaches. The guard reads headers only,
   * and this asserts it has not quietly grown a fallback.
   */
  it('does not read a secret from anywhere but a header', () => {
    expect(
      authoriseCronRequest(new Headers({ 'x-not-the-header': SECRET }), env()),
    ).toMatchObject({ ok: false, status: 401 });
  });
});

describe('decideBudget', () => {
  it('reports what is left', () => {
    expect(decideBudget(1.5, 5)).toEqual({
      spentUsd: 1.5,
      capUsd: 5,
      remainingUsd: 3.5,
      exceeded: false,
    });
  });

  /** At exactly the cap the budget is spent. `>` here instead of `>=` would
   *  let every cap be exceeded by one more call, forever. */
  it('treats exactly the cap as exceeded', () => {
    expect(decideBudget(5, 5).exceeded).toBe(true);
    expect(decideBudget(4.999999, 5).exceeded).toBe(false);
  });

  /** A cap of zero must refuse everything, and `0 > 0` is false. */
  it('refuses everything at a cap of zero', () => {
    expect(decideBudget(0, 0).exceeded).toBe(true);
  });

  it('never reports negative remaining', () => {
    expect(decideBudget(9, 5).remainingUsd).toBe(0);
  });
});
