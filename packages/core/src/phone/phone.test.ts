import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { tokenKeysFromEnv } from '../integrations/crypto';
import { fakeFetch } from '../integrations/fake-fetch';
import { ProviderError } from '../integrations/provider-http';
import { displayAu, forwardingCodes, isAuMobile, smsKeyword, toAuE164, verifyWebhookToken, webhookToken, webhookUrl, xmlEscape } from './format';
import { connectTwilio, PhoneError, providerFailure, type PhoneDeps } from './setup';
import { kycFromBundles, twilioClient } from './twilio';
import { handleTwilioWebhook } from './webhooks';
import { decideMissedCallText, DEFAULT_MISSED_CALL_SETTINGS, firstName, NO_TEXT_GREETING, renderMissedCallTemplate, unknownFields } from './missed-calls';

const keys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;
const otherKeys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;
const numberId = '11111111-2222-4333-8444-555555555555';
const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;

describe('Australian numbers (ADR 0070)', () => {
  it('reads the shapes people type into E.164, and only mobiles can be texted', () => {
    expect(toAuE164('0412 345 678')).toBe('+61412345678');
    expect(toAuE164('+61 412 345 678')).toBe('+61412345678');
    expect(toAuE164('(03) 9555 1234')).toBe('+61395551234');
    expect(toAuE164('+44 20 7946 0958')).toBeNull();
    expect(toAuE164('123')).toBeNull();
    expect(isAuMobile('+61412345678')).toBe(true);
    expect(isAuMobile('+61395551234')).toBe(false);
    expect(displayAu('+61480999888')).toBe('0480 999 888');
    expect(displayAu('+61395551234')).toBe('(03) 9555 1234');
    expect(displayAu('+442079460958')).toBe('+442079460958');
  });

  it('gives the no-reply forwarding code to the agent’s Twilio number, and the code to stop it', () => {
    expect(forwardingCodes('telstra', '+61480999888', 20)).toEqual({ on: '**61*0480999888**20#', off: '##61#' });
    expect(forwardingCodes('optus', '+61480999888', 15).on).toBe('**61*0480999888**15#');
    // An unexpected delay falls back to 20 seconds rather than writing whatever came in.
    expect(forwardingCodes('other', '+61480999888', 99).on).toBe('**61*0480999888**20#');
  });

  it('hears STOP and START only as the whole message', () => {
    expect(smsKeyword('STOP')).toBe('stop');
    expect(smsKeyword(' stop. ')).toBe('stop');
    expect(smsKeyword('Unsubscribe')).toBe('stop');
    expect(smsKeyword('start')).toBe('start');
    expect(smsKeyword('please stop calling me at work')).toBeNull();
  });

  it('escapes what goes into TwiML', () => {
    expect(xmlEscape(`Sarah's <b> & "x"`)).toBe('Sarah&apos;s &lt;b&gt; &amp; &quot;x&quot;');
  });
});

describe('the per-number webhook token', () => {
  it('round-trips, and names the number in the URL', () => {
    const t = webhookToken(numberId, keys);
    expect(verifyWebhookToken(t, keys)).toBe(numberId);
    expect(webhookUrl('https://site.example/', numberId, 'sms', keys)).toBe(`https://site.example/api/phone/twilio/${t}/sms`);
  });

  it('refuses a token made with another key, a changed signature, another number, or junk', () => {
    const t = webhookToken(numberId, keys);
    expect(verifyWebhookToken(webhookToken(numberId, otherKeys), keys)).toBeNull();
    expect(verifyWebhookToken(`${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`, keys)).toBeNull();
    expect(verifyWebhookToken(`99999999-2222-4333-8444-555555555555.${t.split('.')[1]}`, keys)).toBeNull();
    expect(verifyWebhookToken('nope', keys)).toBeNull();
    expect(verifyWebhookToken(`${numberId}.`, keys)).toBeNull();
  });
});

describe('the Twilio client', () => {
  const creds = { accountSid: `AC${'a'.repeat(32)}`, apiKeySid: `SK${'b'.repeat(32)}`, apiKeySecret: 'secret-secret-secret' };

  it('authenticates with the API key, never the account SID alone', async () => {
    const f = fakeFetch([{ status: 200, body: { friendly_name: 'Pakenham Realty' } }]);
    expect(await twilioClient(creds, f.impl).account()).toEqual({ friendlyName: 'Pakenham Realty' });
    expect(f.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}.json`);
    expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${creds.apiKeySid}:${creds.apiKeySecret}`).toString('base64')}`);
  });

  it('buys a number with its bundle and both webhooks, form-encoded', async () => {
    const f = fakeFetch([{ status: 201, body: { sid: 'PN1', phone_number: '+61480999888' } }]);
    const r = await twilioClient(creds, f.impl).buyNumber({ e164: '+61480999888', bundleSid: 'BU1', smsUrl: 'https://s/sms', voiceUrl: 'https://s/voice' });
    expect(r).toEqual({ sid: 'PN1', e164: '+61480999888' });
    const body = new URLSearchParams(f.calls[0]!.body);
    expect(f.calls[0]!.method).toBe('POST');
    expect(Object.fromEntries(body)).toMatchObject({ PhoneNumber: '+61480999888', BundleSid: 'BU1', SmsUrl: 'https://s/sms', VoiceUrl: 'https://s/voice' });
  });

  it('re-points a number’s texts and calls at new URLs (a domain cutover)', async () => {
    const f = fakeFetch([{ status: 200, body: { sid: 'PN1' } }]);
    await twilioClient(creds, f.impl).setNumberWebhooks('PN1', { smsUrl: 'https://new.example/sms', voiceUrl: 'https://new.example/voice' });
    expect(f.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/IncomingPhoneNumbers/PN1.json`);
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body))).toMatchObject({ SmsUrl: 'https://new.example/sms', VoiceUrl: 'https://new.example/voice', SmsMethod: 'POST', VoiceMethod: 'POST' });
  });

  it('turns a refused key into a message without the key', async () => {
    const f = fakeFetch([{ status: 401, body: { code: 20003, message: 'Authenticate' } }]);
    const err = await twilioClient(creds, f.impl).account().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const msg = providerFailure(err, 'Twilio did not accept this key.').message;
    expect(msg).toBe('Twilio did not accept this key.');
    expect(msg).not.toContain(creds.apiKeySecret);
  });

  it('reads business verification from the bundles, approved only when Twilio says so', () => {
    expect(kycFromBundles([{ sid: 'BU1', status: 'twilio-approved' }])).toEqual({ status: 'approved', bundleSid: 'BU1', note: null });
    expect(kycFromBundles([{ sid: 'BU1', status: 'in-review' }]).status).toBe('pending');
    expect(kycFromBundles([{ sid: 'BU1', status: 'twilio-rejected' }]).status).toBe('needs_fix');
    expect(kycFromBundles([{ sid: 'BU1', status: 'draft' }]).status).toBe('none');
    expect(kycFromBundles([{ sid: 'BU1', status: 'something-new' }]).status).toBe('none');
    expect(kycFromBundles([]).status).toBe('none');
  });
});

describe('connecting the agency’s Twilio', () => {
  const deps = (f: ReturnType<typeof fakeFetch>): PhoneDeps => ({ keys, client: (c) => twilioClient(c, f.impl), webhookBase: 'https://site.example' });
  const owner = { userId: 'o', agencyId: 'a', membershipRole: 'owner' as const };

  it('refuses an agent before anything is read', async () => {
    const err = await connectTwilio(noDb, { userId: 's', agencyId: 'a', membershipRole: 'agent' }, { accountSid: '', apiKeySid: '', apiKeySecret: '' }, deps(fakeFetch([]))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhoneError);
    expect((err as PhoneError).code).toBe('forbidden');
  });

  it('checks the shape of the SIDs before calling Twilio', async () => {
    const f = fakeFetch([]);
    const err = await connectTwilio(noDb, owner, { accountSid: 'AC123', apiKeySid: `SK${'b'.repeat(32)}`, apiKeySecret: 'secret-secret-secret' }, deps(f)).catch((e: unknown) => e);
    expect((err as PhoneError).message).toMatch(/Account SID starts with AC/);
    expect(f.calls).toHaveLength(0);
  });

  it('says the server is not set up when there is no key to encrypt with', async () => {
    const err = await connectTwilio(noDb, owner, { accountSid: '', apiKeySid: '', apiKeySecret: '' }, { ...deps(fakeFetch([])), keys: null }).catch((e: unknown) => e);
    expect((err as PhoneError).code).toBe('not_configured');
  });
});

describe('a missed call’s text (ADR 0071)', () => {
  const base = { skillOn: true, from: '+61400123456', optedOut: false, textedToday: false, agentTextsToday: 0, agencyTextsToday: 0, limits: { perAgent: 50, perAgency: 300 } };

  it('sends only when every rule allows it, and otherwise names the first reason', () => {
    expect(decideMissedCallText(base)).toBe('send');
    expect(decideMissedCallText({ ...base, skillOn: false })).toBe('skill_off');
    expect(decideMissedCallText({ ...base, from: null })).toBe('private');
    expect(decideMissedCallText({ ...base, from: '+61395551234' })).toBe('not_mobile');
    expect(decideMissedCallText({ ...base, optedOut: true })).toBe('opted_out');
    expect(decideMissedCallText({ ...base, textedToday: true })).toBe('repeat');
    expect(decideMissedCallText({ ...base, agentTextsToday: 50 })).toBe('limit');
    expect(decideMissedCallText({ ...base, agencyTextsToday: 300 })).toBe('limit');
  });

  it('never texts with the skill off, whatever else is true', () => {
    expect(decideMissedCallText({ ...base, skillOn: false, from: null, optedOut: true })).toBe('skill_off');
  });

  it('fills only the three fields, with a first name or "there"', () => {
    const out = renderMissedCallTemplate(DEFAULT_MISSED_CALL_SETTINGS.smsTemplate, { first_name: firstName('John Smith', 'there'), agent_first_name: firstName('Sarah Khan', 'the agent'), agency_name: 'Pakenham Realty' });
    expect(out).toBe("Hi John, Sarah from Pakenham Realty here. Sorry I missed your call! What can I help with? Reply here or I'll call you back shortly.");
    expect(firstName(null, 'there')).toBe('there');
    expect(firstName('sarah@agency.test', 'the agent')).toBe('the agent');
    expect(renderMissedCallTemplate('Hi {{ first_name }}, {{price}}', { first_name: 'Jo', agent_first_name: '', agency_name: '' })).toBe('Hi Jo, {{price}}');
  });

  it('finds a field the owner made up, so it is refused on save', () => {
    expect(unknownFields('Hi {{first_name}} about {{price}} and {{ agency_name }}')).toEqual(['price']);
    expect(unknownFields(DEFAULT_MISSED_CALL_SETTINGS.greeting)).toEqual([]);
    expect(unknownFields(NO_TEXT_GREETING)).toEqual([]);
  });
});

describe('the webhook door', () => {
  const call = (token: string, kind = 'sms', k: typeof keys | null = keys) => handleTwilioWebhook({ db: () => noDb, token, kind, params: {}, keys: k });

  it('answers 503 when the server has no key, before anything else', async () => {
    expect((await call(webhookToken(numberId, keys), 'sms', null)).status).toBe(503);
  });
  it('refuses a token it did not make, without reaching the database', async () => {
    expect((await call(webhookToken(numberId, otherKeys))).status).toBe(403);
    expect((await call('junk')).status).toBe(403);
  });
  it('refuses a kind it does not know', async () => {
    expect((await call(webhookToken(numberId, keys), 'recording')).status).toBe(404);
  });
});
