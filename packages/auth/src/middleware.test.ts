import type { JwtPayload } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityFromClaims, updateSession } from './middleware';

/**
 * ADR 0046: middleware verifies the session with getClaims — a local ES256
 * check — instead of asking the Auth server with getUser on every request.
 *
 * Real crypto, fake Supabase. Each run makes an ES256 key pair, signs access
 * tokens with it, and serves its public half from a fake JWKS endpoint, so the
 * signature check that runs is the one production runs. The fake also answers
 * the refresh endpoint, and counts calls to /auth/v1/user: the point of the
 * change is that a signed-in navigation never makes one.
 */

const SUPABASE_URL = 'https://testref.supabase.co';
const COOKIE = 'sb-testref-auth-token';
const KID = 'test-key-1';
const USER_ID = '7d3f1c2a-0b5e-4c1d-9a8f-2e6b4d0c1a99';

type Keys = { privateKey: CryptoKey; publicJwk: JsonWebKey };

async function makeKeys(): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

const b64url = (s: string | Uint8Array) => Buffer.from(s).toString('base64url');

async function sign(keys: Keys, claims: JwtPayload): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KID }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);

function claimsFor(exp: number): JwtPayload {
  return {
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: USER_ID,
    email: 'sara@example.com',
    role: 'authenticated',
    aud: 'authenticated',
    iat: exp - 3600,
    exp,
    aal: 'aal1',
    session_id: 'session-1',
    user_metadata: { full_name: 'Sara Khan' },
  };
}

/** The cookie @supabase/ssr writes: `base64-` + the session as base64url JSON. */
function sessionCookie(accessToken: string, expiresAt: number): string {
  const session = { access_token: accessToken, refresh_token: 'refresh-1', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, user: { id: USER_ID } };
  return `base64-${b64url(JSON.stringify(session))}`;
}

function request(cookie: string | null, extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
  if (cookie) headers.set('cookie', `${COOKIE}=${cookie}`);
  return new NextRequest('http://agency.lvh.me:3001/leads', { headers });
}

let good: Keys;
let other: Keys;
const calls: string[] = [];
let refreshAnswer: (() => Promise<Response>) | null = null;

beforeAll(async () => {
  good = await makeKeys();
  other = await makeKeys();
});

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  calls.length = 0;
  refreshAnswer = null;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) {
      return Response.json({ keys: [{ ...good.publicJwk, kid: KID, alg: 'ES256', use: 'sig' }] });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`) && refreshAnswer) return refreshAnswer();
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return Response.json({ id: USER_ID, email: 'sara@example.com' });
    return Response.json({ error: 'not faked' }, { status: 400 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const userCalls = () => calls.filter((u) => u.startsWith(`${SUPABASE_URL}/auth/v1/user`)).length;

describe('identityFromClaims', () => {
  it('takes the id from sub, the address, and the name given at sign-up', () => {
    expect(identityFromClaims(claimsFor(now() + 60))).toEqual({ id: USER_ID, email: 'sara@example.com', label: 'Sara Khan' });
  });

  it('falls back to `name`, then to the address before the @', () => {
    expect(identityFromClaims({ ...claimsFor(1), user_metadata: { name: 'Sara' } })?.label).toBe('Sara');
    expect(identityFromClaims({ ...claimsFor(1), user_metadata: { full_name: '  ' } })?.label).toBe('sara');
  });

  it('names nobody without a string sub', () => {
    expect(identityFromClaims(null)).toBeNull();
    expect(identityFromClaims({ ...claimsFor(1), sub: '' })).toBeNull();
    expect(identityFromClaims({ ...claimsFor(1), sub: 42 as unknown as string })).toBeNull();
  });
});

describe('updateSession (getClaims)', () => {
  it('a token signed by the project key: identity forwarded, and no call to /auth/v1/user', async () => {
    const token = await sign(good, claimsFor(now() + 3600));
    const fwd = new Headers();
    const { user } = await updateSession(request(sessionCookie(token, now() + 3600)), fwd);
    expect(user).toEqual({ id: USER_ID, email: 'sara@example.com', label: 'Sara Khan' });
    expect(fwd.get('x-console-user-id')).toBe(USER_ID);
    expect(decodeURIComponent(fwd.get('x-console-user-label') ?? '')).toBe('Sara Khan');
    expect(userCalls()).toBe(0);
  });

  it('a token signed by any other key is nobody — and a forged id header does not survive', async () => {
    const token = await sign(other, claimsFor(now() + 3600));
    const fwd = new Headers({ 'x-console-user-id': USER_ID, 'x-web-user-id': USER_ID });
    const { user } = await updateSession(request(sessionCookie(token, now() + 3600)), fwd);
    expect(user).toBeNull();
    expect(fwd.get('x-console-user-id')).toBeNull();
    expect(fwd.get('x-web-user-id')).toBeNull();
  });

  it('a token whose claims were edited after signing is nobody', async () => {
    const token = await sign(good, claimsFor(now() + 3600));
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ ...claimsFor(now() + 3600), sub: '00000000-0000-0000-0000-000000000001' }))}.${s}`;
    const { user } = await updateSession(request(sessionCookie(forged, now() + 3600)), new Headers());
    expect(user).toBeNull();
  });

  it('no cookie is nobody, with the headers still stripped', async () => {
    const fwd = new Headers({ 'x-console-user-id': USER_ID });
    const { user } = await updateSession(request(null), fwd);
    expect(user).toBeNull();
    expect(fwd.get('x-console-user-id')).toBeNull();
  });

  it('an expired session is refreshed: new cookie written, identity from the new token', async () => {
    const fresh = await sign(good, claimsFor(now() + 3600));
    refreshAnswer = async () =>
      Response.json({ access_token: fresh, refresh_token: 'refresh-2', token_type: 'bearer', expires_in: 3600, expires_at: now() + 3600, user: { id: USER_ID, email: 'sara@example.com' } });
    const stale = await sign(good, claimsFor(now() - 120));
    const { user, response } = await updateSession(request(sessionCookie(stale, now() - 120)), new Headers());
    expect(user?.id).toBe(USER_ID);
    expect(calls.some((u) => u.includes('/auth/v1/token') && u.includes('refresh_token'))).toBe(true);
    expect(response.cookies.getAll().some((c) => c.name.startsWith(COOKIE) && c.value)).toBe(true);
    expect(userCalls()).toBe(0);
  });

  it('an expired session the Auth server will not refresh is nobody', async () => {
    refreshAnswer = async () => Response.json({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }, { status: 400 });
    const stale = await sign(good, claimsFor(now() - 120));
    const { user } = await updateSession(request(sessionCookie(stale, now() - 120)), new Headers());
    expect(user).toBeNull();
  });
});
