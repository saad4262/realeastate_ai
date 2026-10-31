import { describe, expect, it } from 'vitest';
import { fakeFetch } from './fake-fetch';
import { missingScopes, requiredScopes } from './providers';
import { accountFromIdToken, microsoftAdapter, MICROSOFT_AUTHORIZE_URL, MICROSOFT_TOKEN_URL } from './microsoft-oauth';
import { realAdapterFor } from './oauth';
import { outlookCalendarApi, OUTLOOK_EVENTS_URL } from './outlook-calendar';
import { outlookMailApi, OUTLOOK_SEND_URL } from './outlook-mail';
import { ProviderError } from './provider-http';

/** ADR 0076: Outlook mail and calendar on a scripted Microsoft — never the network. */

const client = { clientId: 'cid', clientSecret: 'secret' };
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

describe('scopes', () => {
  it('asks for least privilege plus a refresh token', () => {
    expect(requiredScopes('outlook_mail')).toEqual(['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read', 'openid', 'email', 'offline_access']);
    expect(requiredScopes('outlook_calendar')).toContain('https://graph.microsoft.com/Calendars.ReadWrite');
  });
  it('reads Microsoft’s own spelling — with or without the Graph prefix, any case — and does not demand what it never reports', () => {
    expect(missingScopes('outlook_mail', ['https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid profile email'])).toEqual([]);
    expect(missingScopes('outlook_mail', ['mail.send user.read'])).toEqual([]);
    expect(missingScopes('outlook_calendar', ['https://graph.microsoft.com/User.Read'])).toEqual(['https://graph.microsoft.com/Calendars.ReadWrite']);
  });
  it('leaves Google’s check as it was', () => {
    expect(missingScopes('gmail', ['https://www.googleapis.com/auth/gmail.send', 'openid', 'https://www.googleapis.com/auth/userinfo.email'])).toEqual([]);
    expect(missingScopes('gmail', ['openid'])).toContain('https://www.googleapis.com/auth/gmail.send');
  });
});

describe('Microsoft sign-in', () => {
  it('the common tenant, PKCE, account picker, query response', () => {
    const url = new URL(microsoftAdapter(client).authorizeUrl({ state: 's1', redirectUri: 'https://x/r', scopes: requiredScopes('outlook_mail'), surface: 'agent', codeChallenge: 'cc' }));
    expect(`${url.origin}${url.pathname}`).toBe(MICROSOFT_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'cid', response_type: 'code', response_mode: 'query', code_challenge: 'cc', code_challenge_method: 'S256', prompt: 'select_account', state: 's1' });
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });
  it('exchanges a code, naming the account by email, else preferred_username', async () => {
    const f = fakeFetch([{ status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'https://graph.microsoft.com/Mail.Send', id_token: idToken({ preferred_username: 'sam@outlook.com' }) } }]);
    const g = await microsoftAdapter(client, f.impl).exchange({ code: 'c', redirectUri: 'https://x/r', codeVerifier: 'v' });
    expect(g).toMatchObject({ accessToken: 'at', refreshToken: 'rt', accountLabel: 'sam@outlook.com' });
    expect(f.calls[0]!.url).toBe(MICROSOFT_TOKEN_URL);
    expect(f.calls[0]!.body).toContain('code_verifier=v');
    expect(f.calls[0]!.body).toContain('client_secret=secret');
    expect(accountFromIdToken(idToken({ email: 'sam@agency.com.au', preferred_username: 'x' }))).toBe('sam@agency.com.au');
  });
  it('a refresh returns the NEW refresh token (Microsoft rotates); a dead grant is "revoked"', async () => {
    const ok = fakeFetch([{ status: 200, body: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3599 } }]);
    expect(await microsoftAdapter(client, ok.impl).refresh('rt1')).toMatchObject({ accessToken: 'at2', refreshToken: 'rt2' });
    const dead = fakeFetch([{ status: 400, body: { error: 'invalid_grant' } }]);
    await expect(microsoftAdapter(client, dead.impl).refresh('rt1')).rejects.toMatchObject({ kind: 'revoked' });
  });
  it('is the adapter for both Outlook providers only when the Entra app is configured', () => {
    expect(realAdapterFor('outlook_mail', { MICROSOFT_CLIENT_ID: 'a', MICROSOFT_CLIENT_SECRET: 'b' } as NodeJS.ProcessEnv)?.kind).toBe('real');
    expect(realAdapterFor('outlook_calendar', { MICROSOFT_CLIENT_ID: 'a', MICROSOFT_CLIENT_SECRET: 'b' } as NodeJS.ProcessEnv)?.kind).toBe('real');
    expect(realAdapterFor('outlook_mail', {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('Outlook Calendar', () => {
  const ev = { title: 'Appraisal', description: 'At 1 Testing Way', location: '1 Testing Way, Pakenham', startsAt: new Date('2026-11-04T00:00:00Z'), endsAt: new Date('2026-11-04T01:00:00Z'), timezone: 'Australia/Melbourne', appointmentId: '11111111-2222-3333-4444-555555555555' };
  it('creates with transactionId = our appointment id, in UTC, with no attendees', async () => {
    const f = fakeFetch([{ status: 201, body: { id: 'AAMkAGI2THVSAAA=', '@odata.etag': 'W/"k1"' } }]);
    const r = await outlookCalendarApi(f.impl).upsert('t', ev);
    expect(r).toEqual({ id: 'AAMkAGI2THVSAAA=', etag: 'W/"k1"' });
    const sent = JSON.parse(f.calls[0]!.body);
    expect(f.calls[0]!.method).toBe('POST');
    expect(f.calls[0]!.url).toBe(OUTLOOK_EVENTS_URL);
    expect(sent.transactionId).toBe(ev.appointmentId);
    expect(sent.start).toEqual({ dateTime: '2026-11-04T00:00:00.000', timeZone: 'UTC' });
    expect(sent).not.toHaveProperty('attendees');
    expect(f.calls[0]!.headers.prefer).toBe('outlook.timezone="UTC"');
  });
  it('updates in place with the stored id; an event deleted in Outlook is created again', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'AAMkAGI2THVSAAA=', '@odata.etag': 'W/"k2"' } }]);
    await outlookCalendarApi(f.impl).upsert('t', ev, 'AAMkAGI2THVSAAA=');
    expect(f.calls[0]!.method).toBe('PATCH');
    expect(f.calls[0]!.url).toBe(`${OUTLOOK_EVENTS_URL}/${encodeURIComponent('AAMkAGI2THVSAAA=')}`);
    const g = fakeFetch([{ status: 404, body: { error: { code: 'ErrorItemNotFound' } } }, { status: 201, body: { id: 'AAMkNEWNEWNEW=' } }]);
    expect((await outlookCalendarApi(g.impl).upsert('t', ev, 'AAMkAGI2THVSAAA=')).id).toBe('AAMkNEWNEWNEW=');
    expect(g.calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
  });
  it('reads back: same change key is unchanged, a moved event is changed (UTC), a deleted one is gone', async () => {
    const same = fakeFetch([{ status: 200, body: { '@odata.etag': 'W/"k2"', start: { dateTime: '2026-11-04T00:00:00.0000000' } } }]);
    expect(await outlookCalendarApi(same.impl).get('t', 'AAMkAGI2THVSAAA=', 'W/"k2"')).toEqual({ kind: 'unchanged' });
    const moved = fakeFetch([{ status: 200, body: { '@odata.etag': 'W/"k3"', start: { dateTime: '2026-11-05T02:30:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-05T03:30:00.0000000' }, isCancelled: false } }]);
    const seen = await outlookCalendarApi(moved.impl).get('t', 'AAMkAGI2THVSAAA=', 'W/"k2"');
    expect(seen).toMatchObject({ kind: 'changed', etag: 'W/"k3"', cancelled: false });
    expect((seen as { startsAt: Date }).startsAt.toISOString()).toBe('2026-11-05T02:30:00.000Z');
    const gone = fakeFetch([{ status: 404 }]);
    expect(await outlookCalendarApi(gone.impl).get('t', 'AAMkAGI2THVSAAA=', null)).toEqual({ kind: 'gone' });
  });
  it('removing an event already gone is fine; an id outside Outlook’s alphabet never reaches a URL', async () => {
    await expect(outlookCalendarApi(fakeFetch([{ status: 404 }]).impl).remove('t', 'AAMkAGI2THVSAAA=')).resolves.toBeUndefined();
    await expect(outlookCalendarApi(fakeFetch([]).impl).remove('t', '../../me/messages')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('Outlook mail', () => {
  const raw = 'From: Sam <sam@agency.com.au>\r\nTo: a@b.test\r\nSubject: Hi\r\nIn-Reply-To: <m1@x>\r\n\r\nHello';
  it('sends the same MIME, base64, as text/plain; 202 is sent', async () => {
    const f = fakeFetch([{ status: 202 }]);
    const r = await outlookMailApi(f.impl).send('t', raw);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.calls[0]).toMatchObject({ url: OUTLOOK_SEND_URL, method: 'POST' });
    expect(f.calls[0]!.headers['content-type']).toBe('text/plain');
    expect(Buffer.from(f.calls[0]!.body, 'base64').toString('utf8')).toBe(raw);
  });
  it('maps Microsoft’s answers: 401 renew, 429 limit, 403 reconnect', async () => {
    await expect(outlookMailApi(fakeFetch([{ status: 401 }]).impl).send('t', raw)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(outlookMailApi(fakeFetch([{ status: 429 }]).impl).send('t', raw)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(outlookMailApi(fakeFetch([{ status: 403, body: { error: { code: 'ErrorAccessDenied' } } }]).impl).send('t', raw)).rejects.toThrow(/reconnect Outlook/);
  });
});
