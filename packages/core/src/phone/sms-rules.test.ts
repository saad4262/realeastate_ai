import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_SKILLS, SKILL_OF_WORKFLOW_STEP } from '../skill-switches/catalog';
import { actionInWords, REACHES_CONTACT, specProblem, workflowSpecSchema } from '../workflows/catalog';
import { stepsFor, type Facts } from '../workflows/engine';
import {
  DEFAULT_AUTO_TEXTS_PER_CALLER_DAY,
  DEFAULT_SMS_HOURS,
  DEFAULT_TEXTS_PER_NUMBER_DAY,
  fromNumberFor,
  inSmsHours,
  nextSmsTime,
  readSmsHours,
  smsDevAllowlist,
  smsSkipReason,
} from './sms-rules';

/** ADR 0074 part 2: the five SMS rules (the user's answers, 2026-11-02) and the workflow step "Send SMS". */

const ok = { archived: false, optedOut: false, smsOptedOut: false, consent: true, mobile: '+61412555019', hasFromNumber: true };

describe('who may get a marketing text (rule 2)', () => {
  it('a mobile with consent and a number to send from gets it', () => {
    expect(smsSkipReason(ok)).toBeNull();
  });
  it('names the first reason, the unsubscribe and STOP before consent', () => {
    expect(smsSkipReason({ ...ok, archived: true, optedOut: true })).toBe('archived');
    expect(smsSkipReason({ ...ok, optedOut: true, consent: false })).toBe('opted_out');
    expect(smsSkipReason({ ...ok, smsOptedOut: true, consent: false })).toBe('sms_opted_out');
    expect(smsSkipReason({ ...ok, consent: false })).toBe('no_consent');
  });
  it('texts only an Australian mobile, never a landline or nothing', () => {
    expect(smsSkipReason({ ...ok, mobile: '+61395551234' })).toBe('no_mobile');
    expect(smsSkipReason({ ...ok, mobile: null })).toBe('no_mobile');
  });
  it('consent is never weaker than Bulk email: without it, a skill being on changes nothing', () => {
    // The rule takes no "skill on" input at all: consent is the Bulk email rule whatever is switched on.
    expect(smsSkipReason({ ...ok, consent: false })).toBe('no_consent');
  });
});

describe('from which number (rule 1)', () => {
  const sarah = { id: 'n-sarah', e164: '+61480012345', userId: 'u-sarah' };
  const owner = { id: 'n-owner', e164: '+61480012300', userId: 'u-owner' };
  const numbers = new Map([[sarah.userId, sarah]]);
  it('the contact’s own agent’s number first', () => {
    expect(fromNumberFor('u-sarah', numbers, owner)).toBe(sarah);
  });
  it('else the agency number: nobody assigned, or their agent has none', () => {
    expect(fromNumberFor(null, numbers, owner)).toBe(owner);
    expect(fromNumberFor('u-james', numbers, owner)).toBe(owner);
  });
  it('neither: no number, and the person is skipped', () => {
    expect(fromNumberFor('u-james', numbers, null)).toBeNull();
    expect(smsSkipReason({ ...ok, hasFromNumber: false })).toBe('no_number');
  });
});

describe('sending hours (rule 3) and the caps (rules 4 and 5)', () => {
  const tz = 'Australia/Sydney';
  it('defaults to 9 am to 8 pm, 3 automatic texts a caller and 100 a number', () => {
    expect(DEFAULT_SMS_HOURS).toEqual([9, 20]);
    expect(DEFAULT_AUTO_TEXTS_PER_CALLER_DAY).toBe(3);
    expect(DEFAULT_TEXTS_PER_NUMBER_DAY).toBe(100);
  });
  it('inside the hours sends now; before 9 waits for 9; after 8 pm waits for 9 the next day (the agency’s clock)', () => {
    const noon = new Date('2026-11-02T01:00:00Z'); // 12:00 in Sydney (AEDT, +11)
    expect(inSmsHours(noon, DEFAULT_SMS_HOURS, tz)).toBe(true);
    expect(nextSmsTime(noon, DEFAULT_SMS_HOURS, tz)).toEqual(noon);
    const early = new Date('2026-11-01T19:30:00Z'); // 06:30 on the 2nd
    expect(inSmsHours(early, DEFAULT_SMS_HOURS, tz)).toBe(false);
    expect(nextSmsTime(early, DEFAULT_SMS_HOURS, tz).toISOString()).toBe('2026-11-01T22:00:00.000Z'); // 09:00 on the 2nd
    const late = new Date('2026-11-02T09:30:00Z'); // 20:30 on the 2nd
    expect(inSmsHours(late, DEFAULT_SMS_HOURS, tz)).toBe(false);
    expect(nextSmsTime(late, DEFAULT_SMS_HOURS, tz).toISOString()).toBe('2026-11-02T22:00:00.000Z'); // 09:00 on the 3rd
  });
  it('8 pm itself is outside: the hours are [from, to)', () => {
    expect(inSmsHours(new Date('2026-11-02T09:00:00Z'), DEFAULT_SMS_HOURS, tz)).toBe(false);
  });
  it('reads stored hours, and anything odd is the default', () => {
    expect(readSmsHours([8, 18])).toEqual([8, 18]);
    expect(readSmsHours([20, 9])).toEqual(DEFAULT_SMS_HOURS);
    expect(readSmsHours('9-8')).toEqual(DEFAULT_SMS_HOURS);
    expect(readSmsHours(null)).toEqual(DEFAULT_SMS_HOURS);
  });
});

describe('outside production nobody real is texted', () => {
  it('only the allowlisted mobiles, in any spelling', () => {
    const allowed = smsDevAllowlist({ NODE_ENV: 'development', SMS_DEV_ALLOWLIST: '0412 555 019, +61400000001' } as NodeJS.ProcessEnv)!;
    expect(allowed('+61412555019')).toBe(true);
    expect(allowed('+61400000001')).toBe(true);
    expect(allowed('+61499999999')).toBe(false);
  });
  it('with no list, nobody', () => {
    expect(smsDevAllowlist({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)!('+61412555019')).toBe(false);
  });
  it('the stub sends nothing anywhere, and production has no list', () => {
    expect(smsDevAllowlist({ NODE_ENV: 'development', PHONE_STUB: '1' } as NodeJS.ProcessEnv)).toBeNull();
    expect(smsDevAllowlist({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('the workflow step "Send SMS"', () => {
  const TPL = '33333333-3333-4333-8333-333333333333';
  const AGENT = '11111111-1111-4111-8111-111111111111';
  const facts = (over: Partial<Facts> = {}): Facts => ({
    agencyId: 'agency-a', leadId: null, leadStatus: null, leadKind: null, leadSource: null, leadAssignee: null, leadListingId: null,
    contactId: 'contact-1', contactName: 'Jo Smith', contactAssignee: AGENT, contactRoles: [], listingId: null, listingSuburb: null,
    listingChannel: null, listingAddress: null, listingLat: null, listingLng: null, appointmentId: null, appointmentType: null, appointmentAgent: null,
    dealAgent: null, callAgent: AGENT, callerPhone: '0412 555 019', ...over,
  });
  const spec = (trigger: unknown) => workflowSpecSchema.parse({ trigger, actions: [{ type: 'send_template_sms', template_id: TPL }] });
  const merge = { first_name: 'Jo', full_name: 'Jo Smith', agent_name: 'Sarah', agency_name: 'Coast' };

  it('reaches a contact, behind the pair skill "Workflow texts"', () => {
    expect(REACHES_CONTACT).toContain('send_template_sms');
    expect(SKILL_OF_WORKFLOW_STEP.send_template_sms).toBe('workflow_texts');
    expect(PLATFORM_SKILLS.find((s) => s.key === 'workflow_texts')).toMatchObject({ group: 'Phone & SMS', pair: true, needs: 'Twilio' });
  });
  it('becomes one send_template_sms card for the contact, with the workflow’s name', () => {
    const steps = stepsFor({ name: 'Missed call follow-up' }, spec({ kind: 'call.missed', caller: 'known' }), facts(), merge, new Date(), 'Australia/Sydney');
    expect(steps).toMatchObject([{ tool: 'send_template_sms', contactId: 'contact-1', args: { tool: 'send_template_sms', templateId: TPL, contactIds: ['contact-1'], workflowName: 'Missed call follow-up' } }]);
  });
  it('a missed call from a new number has no contact to text', () => {
    expect(specProblem(spec({ kind: 'call.missed', caller: 'new' }), 'mine')).toMatch(/no contact yet/);
    expect(stepsFor({ name: 'w' }, spec({ kind: 'call.missed' }), facts({ contactId: null }), merge, new Date(), 'Australia/Sydney')).toEqual({ problem: 'the caller is not in Contacts' });
  });
  it('says the hours and the number in words', () => {
    expect(actionInWords({ type: 'send_template_sms', template_id: TPL }, { [TPL]: 'Missed call' })).toMatch(/“Missed call”.*agent’s number, 9 am to 8 pm/);
  });
});

describe('an SMS batch never goes out as email', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const send = readFileSync(resolve(here, '../template-email/send.ts'), 'utf8');
  const batches = readFileSync(resolve(here, '../template-email/batches.ts'), 'utf8');
  it('the email sender, the email resume tick and the email approve all ask for channel email', () => {
    expect(send).toMatch(/batch\.channel !== 'email'/);
    expect(send).toMatch(/eq\(emailBatch\.channel, 'email'\)/);
    expect(batches).toMatch(/if \(b\.channel !== 'email'\) throw/);
  });
});
