import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { tokenKeysFromEnv } from './crypto';
import { fakeFetch } from './fake-fetch';
import { browserHost, completeConnect, returnHop } from './oauth';
import { signState } from './state';
import type { Surface } from './oauth';

/**
 * The return route's hand-over (ADR 0020). The bug this guards: in `next dev`
 * `request.nextUrl` is built from the server's bind address, so on
 * agents.lvh.me:3001 the route still believed it was on localhost:3001 and
 * redirected to itself until Safari gave up ("Too many redirects").
 */

const keys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;
const AGENT = 'http://agents.lvh.me:3001';
const AGENCY = 'http://agency.lvh.me:3001';
const env = {
  NEXT_PUBLIC_AGENT_URL: AGENT,
  NEXT_PUBLIC_AGENCY_URL: AGENCY,
  INTEGRATION_OAUTH_RETURN_BASE: 'http://localhost:3001',
  GOOGLE_OAUTH_CLIENT_ID: 'id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
} as unknown as NodeJS.ProcessEnv;

const userId = '11111111-1111-1111-1111-111111111111';
const agencyId = '22222222-2222-2222-2222-222222222222';

function callback(surface: Surface) {
  const state = signState({ provider: 'google_calendar', ownerType: 'user', ownerId: userId, agencyId, userId, surface }, keys);
  // What Google actually sends back, `iss` included.
  return new URLSearchParams({ state, code: '4/0Atest', iss: 'https://accounts.google.com', scope: 'openid email' });
}

/** What the route sees: Next dev reports localhost:3001 whatever the browser used. */
function routeHop(host: string, query: URLSearchParams) {
  return returnHop(browserHost(new Headers({ host })), query, keys, env);
}

describe('returnHop', () => {
  for (const [surface, home, other] of [
    ['agent', AGENT, AGENCY],
    ['agency', AGENCY, AGENT],
  ] as const) {
    describe(`${surface} surface`, () => {
      it('hands localhost over to the console host the state names', () => {
        const hop = routeHop('localhost:3001', callback(surface));
        expect(hop?.startsWith(`${home}/api/integrations/oauth/return?`)).toBe(true);
      });

      it('does not hop on its own host, however the host is spelled', () => {
        const q = callback(surface);
        const host = new URL(home).host;
        expect(routeHop(host, q)).toBeNull();
        expect(routeHop(host.toUpperCase(), q)).toBeNull();
        expect(returnHop(home, q, keys, env)).toBeNull();
      });

      it('hands the other surface’s host over to its own', () => {
        expect(routeHop(new URL(other).host, callback(surface))?.startsWith(`${home}/`)).toBe(true);
      });

      it('hops at most once, even if the second leg still looks like the wrong host', () => {
        const first = routeHop('localhost:3001', callback(surface))!;
        const landed = new URL(first);
        // Arriving on the right host: done.
        expect(routeHop(landed.host, landed.searchParams)).toBeNull();
        // Next (or a proxy) misreporting the host must not start a loop.
        expect(routeHop('localhost:3001', landed.searchParams)).toBeNull();
        expect(returnHop('http://localhost:3001', landed.searchParams, keys, env)).toBeNull();
      });
    });
  }

  it('takes the target only from the environment, never from the URL', () => {
    const q = callback('agent');
    q.set('redirect_uri', 'https://evil.example');
    q.set('next', 'https://evil.example');
    const hop = routeHop('evil.example', q)!;
    expect(new URL(hop).origin).toBe(AGENT);
  });

  it('forwards nothing for a state that is not ours', () => {
    const q = callback('agent');
    q.set('state', `${q.get('state')}x`);
    expect(routeHop('localhost:3001', q)).toBeNull();
  });
});

describe('browserHost', () => {
  it('prefers the forwarded host, then the Host header', () => {
    expect(browserHost(new Headers({ host: 'localhost:3001', 'x-forwarded-host': 'agents.lvh.me:3001' }))).toBe('agents.lvh.me:3001');
    expect(browserHost(new Headers({ host: 'agency.lvh.me:3001' }))).toBe('agency.lvh.me:3001');
    expect(browserHost(new Headers({ 'x-forwarded-host': 'a.example, proxy.internal' }))).toBe('a.example');
  });
});

describe('completeConnect, when the exchange fails', () => {
  it('says "Connect again" and spends the single-use code exactly once', async () => {
    const google = fakeFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } }]);
    const actor = { userId, agencyId, membershipRole: 'agent' as const };
    // The exchange fails before anything is stored, so no database is touched.
    const outcome = await completeConnect({} as Db, keys, actor, callback('agent'), env, google.impl);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/Connect again/);
    expect(google.calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);
  });
});
