import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { describe, expect, it } from 'vitest';
import { fakeFetch } from './fake-fetch';
import { handleZoomWebhook, verifyZoomSignature } from './zoom-webhook';
import { zoomAdapter } from './zoom-oauth';

const SECRET = 'zoom-secret-token';
const NOW = 1_760_000_000_000;
const env = { ZOOM_WEBHOOK_SECRET_TOKEN: SECRET, ZOOM_OAUTH_CLIENT_ID: 'our-client' } as NodeJS.ProcessEnv;

function signed(body: object, opts: { secret?: string; tsSeconds?: number } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(opts.tsSeconds ?? Math.floor(NOW / 1000));
  const signature = `v0=${createHmac('sha256', opts.secret ?? SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  return { rawBody, headers: { signature, timestamp } };
}

/** A db whose only door is `delete … where … returning`; records the WHERE as SQL text. */
function fakeDb(deleted = 1) {
  const seen: { sql: string; params: unknown[] }[] = [];
  let opened = 0;
  const db = {
    delete: () => ({
      where: (w: SQL) => {
        seen.push(new PgDialect().sqlToQuery(w));
        return { returning: async () => Array.from({ length: deleted }, (_, i) => ({ id: `row-${i}` })) };
      },
    }),
  } as unknown as Db;
  return { db: () => ((opened += 1), db), seen, opened: () => opened };
}

const deauth = (payload: Record<string, unknown> = {}) => ({
  event: 'app_deauthorized',
  event_ts: NOW,
  payload: { account_id: 'acc', user_id: 'zoom-user-1', client_id: 'our-client', deauthorization_time: '2026-10-12T00:00:00Z', signature: 'x', ...payload },
});

describe('Zoom webhook signature', () => {
  it('accepts Zoom’s v0 HMAC over v0:<timestamp>:<raw body>', () => {
    const s = signed({ a: 1 });
    expect(verifyZoomSignature({ secret: SECRET, rawBody: s.rawBody, ...s.headers, nowMs: NOW })).toBe(true);
  });

  it('refuses a wrong secret, a changed body, missing headers and an old timestamp', () => {
    const s = signed({ a: 1 });
    expect(verifyZoomSignature({ secret: 'other', rawBody: s.rawBody, ...s.headers, nowMs: NOW })).toBe(false);
    expect(verifyZoomSignature({ secret: SECRET, rawBody: s.rawBody.replace('1', '2'), ...s.headers, nowMs: NOW })).toBe(false);
    expect(verifyZoomSignature({ secret: SECRET, rawBody: s.rawBody, signature: null, timestamp: s.headers.timestamp, nowMs: NOW })).toBe(false);
    expect(verifyZoomSignature({ secret: SECRET, rawBody: s.rawBody, signature: s.headers.signature, timestamp: null, nowMs: NOW })).toBe(false);
    const old = signed({ a: 1 }, { tsSeconds: Math.floor(NOW / 1000) - 6 * 60 });
    expect(verifyZoomSignature({ secret: SECRET, rawBody: old.rawBody, ...old.headers, nowMs: NOW })).toBe(false);
  });
});

describe('Zoom webhook handler', () => {
  it('answers 503 without a Secret Token and 401 unsigned — and never opens the database', async () => {
    const f = fakeDb();
    const s = signed(deauth());
    expect((await handleZoomWebhook({ db: f.db, ...s, env: {} as NodeJS.ProcessEnv, nowMs: NOW })).status).toBe(503);
    expect((await handleZoomWebhook({ db: f.db, rawBody: s.rawBody, headers: { signature: null, timestamp: null }, env, nowMs: NOW })).status).toBe(401);
    const forged = signed(deauth(), { secret: 'guess' });
    expect((await handleZoomWebhook({ db: f.db, ...forged, env, nowMs: NOW })).status).toBe(401);
    expect(f.opened()).toBe(0);
  });

  it('answers the URL validation with the plain token and its HMAC', async () => {
    const s = signed({ event: 'endpoint.url_validation', payload: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw' } });
    const res = await handleZoomWebhook({ db: fakeDb().db, ...s, env, nowMs: NOW });
    expect(res).toEqual({
      status: 200,
      body: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: createHmac('sha256', SECRET).update('qgg8vlvZRS6UYooatFL8Aw').digest('hex') },
    });
  });

  it('a deauthorization deletes the Zoom connections of THAT Zoom user only', async () => {
    const f = fakeDb(2);
    const res = await handleZoomWebhook({ db: f.db, ...signed(deauth()), env, nowMs: NOW });
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'deauthorized', deleted: 2 } });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.sql).toMatch(/"provider" = \$1 and "integration_account"\."external_account_id" = \$2/);
    expect(f.seen[0]!.params).toEqual(['zoom', 'zoom-user-1']);
  });

  it('another app’s deauthorization, other events and a missing user id delete nothing', async () => {
    const f = fakeDb();
    expect((await handleZoomWebhook({ db: f.db, ...signed(deauth({ client_id: 'someone-else' })), env, nowMs: NOW })).body).toMatchObject({ outcome: 'ignored' });
    expect((await handleZoomWebhook({ db: f.db, ...signed({ event: 'meeting.started', payload: {} }), env, nowMs: NOW })).body).toMatchObject({ outcome: 'ignored' });
    expect((await handleZoomWebhook({ db: f.db, ...signed(deauth({ user_id: '' })), env, nowMs: NOW })).status).toBe(400);
    expect(f.seen).toEqual([]);
  });
});

describe('Zoom sign-in keeps the user id', () => {
  it('the exchange returns /users/me id as externalAccountId — the key the deauthorization uses', async () => {
    const f = fakeFetch([
      { status: 200, body: { access_token: 'zat', refresh_token: 'zrt', expires_in: 3599, scope: 'user:read:user' } },
      { status: 200, body: { id: 'zoom-user-1', email: 'host@zoom.test' } },
    ]);
    const g = await zoomAdapter({ clientId: 'c', clientSecret: 's' }, f.impl).exchange({ code: 'c', redirectUri: 'https://t.example/r', codeVerifier: 'v' });
    expect(g.externalAccountId).toBe('zoom-user-1');
  });
});
