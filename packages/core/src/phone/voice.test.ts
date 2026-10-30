import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { tokenKeysFromEnv } from '../integrations/crypto';
import { fakeFetch } from '../integrations/fake-fetch';
import { handleRetellWebhook } from './ai-callback';
import {
  aiOutcomeOf,
  decideAiCallback,
  DEFAULT_CALLING_HOURS,
  nextCallableTime,
  readCallingHours,
  retellClient,
  retellWebhookToken,
  retellWebhookUrl,
  verifyRetellSignature,
  verifyRetellWebhookToken,
} from './voice';

const keys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;
const otherKeys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;
const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
const SYD = 'Australia/Sydney';

describe('calling hours (ADR 0072)', () => {
  // 2026-10-30 is a Friday; Sydney is UTC+11 (daylight time).
  it('keeps a time inside the hours', () => {
    const t = new Date('2026-10-30T03:00:00Z'); // Fri 2:00 pm Sydney
    expect(nextCallableTime(t, DEFAULT_CALLING_HOURS, SYD)?.toISOString()).toBe(t.toISOString());
  });
  it('moves a late-night call to the next morning', () => {
    const t = new Date('2026-10-30T11:30:00Z'); // Fri 10:30 pm Sydney
    expect(nextCallableTime(t, DEFAULT_CALLING_HOURS, SYD)?.toISOString()).toBe('2026-10-30T22:00:00.000Z'); // Sat 9:00 am
  });
  it('skips a day with no hours (Sunday) to Monday 8 am', () => {
    const t = new Date('2026-10-31T07:00:00Z'); // Sat 6:00 pm Sydney, after Saturday's 5 pm
    expect(nextCallableTime(t, DEFAULT_CALLING_HOURS, SYD)?.toISOString()).toBe('2026-11-01T21:00:00.000Z'); // Mon 8:00 am
  });
  it('is null when no day has hours', () => {
    expect(nextCallableTime(new Date(), { weekdays: null, saturday: null, sunday: null }, SYD)).toBeNull();
  });
  it('reads only well-formed stored hours', () => {
    expect(readCallingHours({ weekdays: [9, 17], saturday: null, sunday: null })).toEqual({ weekdays: [9, 17], saturday: null, sunday: null });
    expect(readCallingHours({ weekdays: [17, 9], saturday: null, sunday: null })).toEqual(DEFAULT_CALLING_HOURS);
    expect(readCallingHours('junk')).toEqual(DEFAULT_CALLING_HOURS);
  });
});

describe('whether the AI calls back', () => {
  const base = { skillOn: true, ready: true, from: '+61400123456', optedOut: false, calledToday: false, agentCallsToday: 0, agencyCallsToday: 0, limits: { perAgent: 20, perAgency: 100 } };
  it('schedules only when every rule allows it, else names the first reason', () => {
    expect(decideAiCallback(base)).toBe('schedule');
    expect(decideAiCallback({ ...base, skillOn: false })).toBe('skill_off');
    expect(decideAiCallback({ ...base, ready: false })).toBe('not_ready');
    expect(decideAiCallback({ ...base, from: null })).toBe('private');
    expect(decideAiCallback({ ...base, from: '+442079460958' })).toBe('private');
    expect(decideAiCallback({ ...base, optedOut: true })).toBe('opted_out');
    expect(decideAiCallback({ ...base, calledToday: true })).toBe('repeat');
    expect(decideAiCallback({ ...base, agentCallsToday: 20 })).toBe('limit');
  });
  it('calls a landline back (a call needs no mobile), and never with the skill off', () => {
    expect(decideAiCallback({ ...base, from: '+61395551234' })).toBe('schedule');
    expect(decideAiCallback({ ...base, skillOn: false, ready: false, from: null })).toBe('skill_off');
  });
  it('reads how Retell says a call ended', () => {
    expect(aiOutcomeOf('user_hangup')).toBe('done');
    expect(aiOutcomeOf('dial_no_answer')).toBe('no_answer');
    expect(aiOutcomeOf('voicemail_reached')).toBe('no_answer');
    expect(aiOutcomeOf('error_llm_websocket_open')).toBe('failed');
  });
});

describe('Retell', () => {
  it('starts a call from the agent’s number with the platform agent and our call id', async () => {
    const f = fakeFetch([{ status: 201, body: { call_id: 'call_1', call_status: 'registered' } }]);
    const r = await retellClient('key_live', 'agent_1', f.impl).createCall({
      fromE164: '+61480999888',
      toE164: '+61400123456',
      variables: { agent_first_name: 'Sarah', agency_name: 'Pakenham Realty', caller_first_name: 'John' },
      metadata: { phoneCallId: 'pc1', agencyId: 'a1' },
    });
    expect(r).toEqual({ callId: 'call_1' });
    expect(f.calls[0]!.url).toBe('https://api.retellai.com/v2/create-phone-call');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer key_live');
    expect(JSON.parse(f.calls[0]!.body)).toEqual({
      from_number: '+61480999888',
      to_number: '+61400123456',
      override_agent_id: 'agent_1',
      retell_llm_dynamic_variables: { agent_first_name: 'Sarah', agency_name: 'Pakenham Realty', caller_first_name: 'John' },
      metadata: { phoneCallId: 'pc1', agencyId: 'a1' },
    });
  });

  it('checks its signature over the raw body and timestamp, and refuses an old or changed one', () => {
    const body = '{"event":"call_ended"}';
    const now = 1_800_000_000_000;
    const sig = (b: string, ts: number, key = 'key_live') => `v=${ts},d=${createHmac('sha256', key).update(b + ts).digest('hex')}`;
    expect(verifyRetellSignature(body, sig(body, now), 'key_live', now)).toBe(true);
    expect(verifyRetellSignature(body, sig(body, now, 'other'), 'key_live', now)).toBe(false);
    expect(verifyRetellSignature('{"event":"x"}', sig(body, now), 'key_live', now)).toBe(false);
    expect(verifyRetellSignature(body, sig(body, now - 10 * 60_000), 'key_live', now)).toBe(false);
    expect(verifyRetellSignature(body, null, 'key_live', now)).toBe(false);
  });

  it('puts its own token in the webhook URL and refuses any other', () => {
    expect(retellWebhookUrl('https://site.example/', keys)).toBe(`https://site.example/api/phone/retell/${retellWebhookToken(keys)}`);
    expect(verifyRetellWebhookToken(retellWebhookToken(keys), keys)).toBe(true);
    expect(verifyRetellWebhookToken(retellWebhookToken(otherKeys), keys)).toBe(false);
  });

  it('refuses a webhook with a foreign token, or a bad signature when signatures are on, before any read', async () => {
    const call = (token: string, extra: Partial<Parameters<typeof handleRetellWebhook>[0]> = {}) =>
      handleRetellWebhook({ db: () => noDb, token, rawBody: '{}', signature: null, keys, apiKey: 'key_live', verifySignature: false, ...extra });
    expect((await call('nope')).status).toBe(403);
    expect((await call(retellWebhookToken(keys), { verifySignature: true })).status).toBe(401);
    expect((await call(retellWebhookToken(keys), { keys: null })).status).toBe(503);
    expect((await call(retellWebhookToken(keys), { rawBody: 'not json' })).status).toBe(400);
  });
});
