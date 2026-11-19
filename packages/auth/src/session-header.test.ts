import { describe, expect, it } from 'vitest';
import { readSignedIdentity, sessionHeaderSecret, signIdentity, SIGNED_HEADER_TTL_MS } from './session-header';

/**
 * PLATFORM-PLAN 1.2: the identity middleware forwards is signed, so a request that reaches a page without
 * passing through middleware (CVE-2025-29927 showed it can happen) cannot name a user by sending the headers.
 */

const SECRET = 'test-secret-for-session-headers';
const NOW = 1_800_000_000_000;
const who = { id: '7d3f1c2a-0b5e-4c1d-9a8f-2e6b4d0c1a99', email: 'sara@example.com', label: 'Sara Khan', aal: 'aal1' as const };

async function headersFor(prefix: 'x-console-user' | 'x-web-user' = 'x-console-user', now = NOW, secret = SECRET) {
  const h = new Headers();
  for (const [k, v] of Object.entries((await signIdentity(prefix, who, now, secret))!)) h.set(k, v);
  return h;
}
const read = (h: Headers, opts: { prefix?: 'x-console-user' | 'x-web-user'; now?: number; secret?: string | null } = {}) =>
  readSignedIdentity((n) => h.get(n), opts.prefix ?? 'x-console-user', opts.now ?? NOW, opts.secret === undefined ? SECRET : opts.secret);

describe('signed session headers', () => {
  it('round-trips the identity, the label and address decoded', async () => {
    expect(await read(await headersFor())).toEqual(who);
  });

  it('refuses a changed id, address or label', async () => {
    for (const [name, value] of [
      ['x-console-user-id', '00000000-0000-0000-0000-000000000001'],
      ['x-console-user-email', encodeURIComponent('owner@other.example')],
      ['x-console-user-label', encodeURIComponent('Someone else')],
      // PLATFORM-PLAN 1.3: a second factor claimed by the header alone is not believed.
      ['x-console-user-aal', 'aal2'],
    ] as const) {
      const h = await headersFor();
      h.set(name, value);
      expect(await read(h), name).toBeNull();
    }
  });

  it('carries the assurance level: aal2 round-trips; a header without one is nobody', async () => {
    const h = new Headers();
    for (const [k, v] of Object.entries((await signIdentity('x-console-user', { ...who, aal: 'aal2' }, NOW, SECRET))!)) h.set(k, v);
    expect(await read(h)).toEqual({ ...who, aal: 'aal2' });
    h.delete('x-console-user-aal');
    expect(await read(h)).toBeNull();
  });

  it('refuses headers with no signature, a made-up one, or another secret', async () => {
    const h = await headersFor();
    h.delete('x-console-user-sig');
    expect(await read(h)).toBeNull();
    h.set('x-console-user-sig', 'A'.repeat(43));
    expect(await read(h)).toBeNull();
    expect(await read(await headersFor('x-console-user', NOW, 'another-secret'))).toBeNull();
  });

  it('refuses an expired header and one dated too far ahead', async () => {
    expect(await read(await headersFor(), { now: NOW + SIGNED_HEADER_TTL_MS + 1 })).toBeNull();
    expect(await read(await headersFor('x-console-user', NOW + 10 * 60_000))).toBeNull();
    expect(await read(await headersFor(), { now: NOW + SIGNED_HEADER_TTL_MS - 1 })).toEqual(who);
  });

  it('a console identity is not a consumer identity, nor the reverse', async () => {
    const console = await headersFor('x-console-user');
    const asWeb = new Headers();
    for (const [k, v] of console) asWeb.set(k.replace('x-console-user', 'x-web-user'), v);
    expect(await read(asWeb, { prefix: 'x-web-user' })).toBeNull();
  });

  it('with no secret configured nothing is signed and nothing is believed (fails closed)', async () => {
    expect(await signIdentity('x-console-user', who, NOW, null)).toBeNull();
    expect(await read(await headersFor(), { secret: null })).toBeNull();
  });

  it('takes its secret from SESSION_HEADER_SECRET, else the service-role key', () => {
    expect(sessionHeaderSecret({ SESSION_HEADER_SECRET: ' a ', SUPABASE_SERVICE_ROLE_KEY: 'b' })).toBe('a');
    expect(sessionHeaderSecret({ SUPABASE_SERVICE_ROLE_KEY: 'b' })).toBe('b');
    expect(sessionHeaderSecret({})).toBeNull();
  });
});
