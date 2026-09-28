import { afterEach, describe, expect, it } from 'vitest';
import { cookieDomainFor } from '@repo/auth/cookie-domain';

const original = process.env.COOKIE_DOMAIN;
afterEach(() => {
  process.env.COOKIE_DOMAIN = original;
});

/**
 * A cookie the browser throws away is the worst kind of bug: sign-in looks
 * like it worked, the redirect happens, and there is no session and no log
 * line anywhere. RFC 6265 requires `Domain` to domain-match the host, and
 * `.lvh.me` does not match `localhost`.
 *
 * Tested from @repo/core because packages/auth has no test runner of its
 * own and `pnpm test` runs core and ai.
 */
describe('cookieDomainFor', () => {
  it('claims the shared domain for hosts that belong to it', () => {
    process.env.COOKIE_DOMAIN = '.lvh.me';

    for (const host of ['web.lvh.me:3000', 'agency.lvh.me:3001', 'agents.lvh.me', 'lvh.me']) {
      expect(cookieDomainFor(host), host).toBe('.lvh.me');
    }
  });

  /**
   * The bug. On localhost this used to return `.lvh.me`, the browser
   * discarded every session cookie, and nobody could stay signed in.
   */
  it('claims nothing on a host outside it, so the cookie is host-only', () => {
    process.env.COOKIE_DOMAIN = '.lvh.me';

    for (const host of ['localhost:3000', '127.0.0.1:3000', 'preview.vercel.app']) {
      expect(cookieDomainFor(host), host).toBeUndefined();
    }
  });

  /** "evil-lvh.me" ends with "lvh.me" as a string but is a different site. */
  it('is not fooled by a suffix that is not a subdomain', () => {
    process.env.COOKIE_DOMAIN = '.lvh.me';
    expect(cookieDomainFor('evil-lvh.me')).toBeUndefined();
    expect(cookieDomainFor('notlvh.me')).toBeUndefined();
  });

  it('claims nothing when nothing is configured', () => {
    delete process.env.COOKIE_DOMAIN;
    expect(cookieDomainFor('web.lvh.me:3000')).toBeUndefined();
  });

  it('survives a missing host rather than throwing', () => {
    process.env.COOKIE_DOMAIN = '.lvh.me';
    expect(cookieDomainFor(null)).toBeUndefined();
    expect(cookieDomainFor(undefined)).toBeUndefined();
    expect(cookieDomainFor('')).toBeUndefined();
  });
});
