import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tokenKeysFromEnv } from './crypto';
import { googleAdapter, GOOGLE_TOKEN_URL } from './google-oauth';
import { adapterFor, adapterForTokens, pkceChallenge, pkceVerifier, returnUri, startConnect } from './oauth';
import { fakeFetch } from './fake-fetch';
import { ProviderError } from './provider-http';
import { missingScopes } from './providers';
import { zoomAdapter, ZOOM_TOKEN_URL } from './zoom-oauth';

const client = { clientId: 'cid', clientSecret: 'csecret' };
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

describe('Google sign-in', () => {
  it('asks for offline access with PKCE and only the scopes given', () => {
    const url = new URL(googleAdapter(client).authorizeUrl({ state: 's', redirectUri: 'http://localhost:3001/r', scopes: ['openid', 'email'], surface: 'agent', codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({ access_type: 'offline', prompt: 'consent', code_challenge: 'ch', code_challenge_method: 'S256', scope: 'openid email', state: 's' });
    expect(q.include_granted_scopes).toBeUndefined();
    expect(url.toString()).not.toContain('csecret');
  });

  it('exchanges a code: tokens, granted scopes, the account email', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3599,
          scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events.owned',
          id_token: idToken({ email: 'agent@gmail.com' }),
        },
      },
    ]);
    const g = await googleAdapter(client, f.impl).exchange({ code: 'c', redirectUri: 'http://localhost:3001/r', codeVerifier: 'v' });
    expect(g).toMatchObject({ accessToken: 'at', refreshToken: 'rt', accountLabel: 'agent@gmail.com' });
    expect(missingScopes('google_calendar', g.grantedScopes)).toEqual([]);
    expect(f.calls[0]!.url).toBe(GOOGLE_TOKEN_URL);
    expect(new URLSearchParams(f.calls[0]!.body).get('code_verifier')).toBe('v');
  });

  it('a dead refresh token (invalid_grant) is "revoked"; a 503 is not', async () => {
    const dead = fakeFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }]);
    const err = await googleAdapter(client, dead.impl).refresh('rt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('revoked');
    expect((err as Error).message).not.toContain('rt');

    const down = fakeFetch([{ status: 503 }]);
    expect(((await googleAdapter(client, down.impl).refresh('rt').catch((e: unknown) => e)) as ProviderError).kind).toBe('failed');
  });

  it('a renewed token keeps the old refresh token unless Google sends a new one', async () => {
    const f = fakeFetch([{ status: 200, body: { access_token: 'at2', expires_in: 3600 } }]);
    expect(await googleAdapter(client, f.impl).refresh('rt')).toMatchObject({ accessToken: 'at2', refreshToken: null });
  });
});

describe('Zoom sign-in', () => {
  it('authenticates the token call with HTTP Basic and reads the account email', async () => {
    const f = fakeFetch([
      { status: 200, body: { access_token: 'zat', refresh_token: 'zrt', expires_in: 3599, scope: 'meeting:write:meeting meeting:update:meeting meeting:delete:meeting user:read:user' } },
      { status: 200, body: { email: 'host@zoom.test' } },
    ]);
    const g = await zoomAdapter(client, f.impl).exchange({ code: 'c', redirectUri: 'https://t.example/r', codeVerifier: 'v' });
    expect(f.calls[0]!.url).toBe(ZOOM_TOKEN_URL);
    expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(f.calls[0]!.body).not.toContain('csecret');
    expect(g).toMatchObject({ accessToken: 'zat', refreshToken: 'zrt', accountLabel: 'host@zoom.test' });
    expect(missingScopes('zoom', g.grantedScopes)).toEqual([]);
  });

  it('a refresh returns the ROTATED refresh token; a 400 means revoked', async () => {
    const ok = fakeFetch([{ status: 200, body: { access_token: 'zat2', refresh_token: 'zrt2', expires_in: 3600 } }]);
    expect(await zoomAdapter(client, ok.impl).refresh('zrt')).toMatchObject({ accessToken: 'zat2', refreshToken: 'zrt2' });
    const dead = fakeFetch([{ status: 400, body: { reason: 'Invalid Token!', error: 'invalid_grant' } }]);
    expect(((await zoomAdapter(client, dead.impl).refresh('zrt').catch((e: unknown) => e)) as ProviderError).kind).toBe('revoked');
  });
});

describe('choosing an adapter', () => {
  const dev = { NODE_ENV: 'development', INTEGRATIONS_STUB: '1' } as NodeJS.ProcessEnv;
  const real = { ...dev, GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b' } as NodeJS.ProcessEnv;

  it('real when configured, else the stub in dev, else nothing; never the stub in production', () => {
    expect(adapterFor('google_calendar', real)?.kind).toBe('real');
    expect(adapterFor('zoom', real)?.kind).toBe('stub');
    expect(adapterFor('zoom', { NODE_ENV: 'production', INTEGRATIONS_STUB: '1' } as NodeJS.ProcessEnv)).toBeNull();
    expect(adapterFor('google_sheets', real)?.kind).toBe('stub');
  });

  it('a stub-issued token is only ever renewed by the stub', () => {
    expect(adapterForTokens('google_calendar', 'stub-access-1', real)?.kind).toBe('stub');
    expect(adapterForTokens('google_calendar', 'stub-access-1', { NODE_ENV: 'production', GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b' } as NodeJS.ProcessEnv)).toBeNull();
    expect(adapterForTokens('google_calendar', 'ya29.real', real)?.kind).toBe('real');
  });

  it('Zoom may come back through its own base; Google through the shared one', () => {
    const env = { INTEGRATION_OAUTH_RETURN_BASE: 'http://localhost:3001', ZOOM_OAUTH_RETURN_BASE: 'https://tunnel.example' } as NodeJS.ProcessEnv;
    expect(returnUri(env, 'google_calendar')).toBe('http://localhost:3001/api/integrations/oauth/return');
    expect(returnUri(env, 'zoom')).toBe('https://tunnel.example/api/integrations/oauth/return');
    expect(returnUri({ INTEGRATION_OAUTH_RETURN_BASE: 'http://localhost:3001' } as NodeJS.ProcessEnv, 'zoom')).toBe('http://localhost:3001/api/integrations/oauth/return');
  });
});

describe('PKCE without storage', () => {
  const keys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;

  it('the challenge sent at the start matches the verifier recomputed at the return', () => {
    const env = { NODE_ENV: 'development', GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b', INTEGRATION_OAUTH_RETURN_BASE: 'http://localhost:3001' } as NodeJS.ProcessEnv;
    const actor = { userId: '11111111-1111-4111-8111-111111111111', agencyId: '22222222-2222-4222-8222-222222222222', membershipRole: 'agent' as const };
    const url = new URL(startConnect(actor, keys, { provider: 'google_calendar', ownerType: 'user', surface: 'agent' }, env));
    const state = url.searchParams.get('state')!;
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(pkceVerifier(state, keys)));
    expect(pkceVerifier(state, keys)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Another server's key gives another verifier.
    const other = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;
    expect(pkceVerifier(state, other)).not.toBe(pkceVerifier(state, keys));
  });
});
