import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Actor } from '../permissions';
import { smsTemplateInputSchema } from './schema';
import { SMS_STOP_FOOTER, SMS_TEMPLATE_MAX, smsParts, withStopFooter } from './sms';
import { usableTemplateSql } from './templates';

/** ADR 0074, part 1: SMS templates' words, their footer, their cost in parts, and the channel in SQL. */

describe('S1 — SMS parts', () => {
  it('GSM-7: 160 in one part, then 153 a part', () => {
    expect(smsParts('a'.repeat(160))).toEqual({ encoding: 'gsm7', units: 160, parts: 1 });
    expect(smsParts('a'.repeat(161)).parts).toBe(2);
    expect(smsParts('a'.repeat(306)).parts).toBe(2);
    expect(smsParts('a'.repeat(307)).parts).toBe(3);
  });
  it('an extension character (€, braces, ~) counts as two', () => {
    expect(smsParts('€'.repeat(80))).toEqual({ encoding: 'gsm7', units: 160, parts: 1 });
    expect(smsParts('€'.repeat(81)).parts).toBe(2);
  });
  it('one emoji, en dash or curly quote turns the whole text into 70 a part, then 67', () => {
    expect(smsParts('Sat 10:30–11:00').encoding).toBe('ucs2');
    expect(smsParts('it’s').encoding).toBe('ucs2');
    expect(smsParts('x'.repeat(70) + '').encoding).toBe('gsm7');
    expect(smsParts('🏠' + 'x'.repeat(68)).parts).toBe(1); // the emoji is two UTF-16 units: 70
    expect(smsParts('🏠' + 'x'.repeat(69)).parts).toBe(2);
    expect(smsParts('é'.repeat(134) + '’').parts).toBe(3);
  });
  it('nothing is no parts; a line break is one septet', () => {
    expect(smsParts('').parts).toBe(0);
    expect(smsParts('a\nb').units).toBe(3);
  });
});

describe('S2 — the STOP footer is always there and counted', () => {
  it('is added after the words, on its own line', () => {
    expect(withStopFooter('Hi Priya  ')).toBe(`Hi Priya\n${SMS_STOP_FOOTER}`);
  });
  it('a full-length template plus the footer is four parts — the editor says so', () => {
    expect(smsParts(withStopFooter('a'.repeat(SMS_TEMPLATE_MAX))).parts).toBe(4);
  });
});

describe('S3 — an SMS template: a name and words, the same merge fields, up to 480', () => {
  it('takes the base and listing merge fields', () => {
    expect(smsTemplateInputSchema.safeParse({ name: 'Open home', body: 'Hi {{first_name}}, open home at {{listing_address}} - {{agent_name}}' }).success).toBe(true);
  });
  it('refuses an unknown field, an empty text and 481 characters', () => {
    expect(smsTemplateInputSchema.safeParse({ name: 'X1', body: 'Hi {{suburb}}' }).success).toBe(false);
    expect(smsTemplateInputSchema.safeParse({ name: 'X1', body: '   ' }).success).toBe(false);
    expect(smsTemplateInputSchema.safeParse({ name: 'X1', body: 'a'.repeat(481) }).success).toBe(false);
    expect(smsTemplateInputSchema.safeParse({ name: 'X1', body: 'a'.repeat(480) }).success).toBe(true);
  });
});

describe('S4 — the templates an email path may list are email ones', () => {
  const actor: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'agent' };
  const text = (channel?: 'email' | 'sms') => {
    const q = new PgDialect().sqlToQuery(channel ? usableTemplateSql(actor, channel) : usableTemplateSql(actor));
    return { sql: q.sql, params: q.params };
  };
  it('by default the SQL asks for channel = email', () => {
    const q = text();
    expect(q.sql).toMatch(/"channel" = \$1/);
    expect(q.params[0]).toBe('email');
  });
  it('asked for SMS, it asks for sms', () => {
    expect(text('sms').params[0]).toBe('sms');
  });
});
