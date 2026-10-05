import { describe, expect, it } from 'vitest';
import { buildConversationEmail } from './conversation';
import { devAllowlist, emailLimitsFromEnv } from './limits';
import { signContactUnsubscribeToken, signUnsubscribeToken, verifyContactUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe';

const secret = 'x'.repeat(32);
const contactId = '11111111-1111-1111-1111-111111111111';

describe('contact unsubscribe tokens', () => {
  it('round-trips, and is never readable as a saved-search token or the reverse', () => {
    const t = signContactUnsubscribeToken(contactId, secret);
    expect(verifyContactUnsubscribeToken(t, secret)).toEqual({ ok: true, contactId });
    expect(verifyUnsubscribeToken(t, secret)).toEqual({ ok: false });
    const schedule = signUnsubscribeToken(contactId, contactId, secret);
    expect(verifyContactUnsubscribeToken(schedule, secret)).toEqual({ ok: false });
  });

  it('refuses a forged or foreign-key token', () => {
    const t = signContactUnsubscribeToken(contactId, secret);
    expect(verifyContactUnsubscribeToken(`${t}x`, secret).ok).toBe(false);
    expect(verifyContactUnsubscribeToken(t, 'y'.repeat(32)).ok).toBe(false);
  });
});

describe('a template email is marketing', () => {
  const base = {
    to: { email: 'tom@example.test' },
    from: { email: 'mail@example.test', name: 'Sara · Alpha' },
    replyTo: { email: 'reply@example.test' },
    postalAddress: '1 Test St, Testville VIC 3000',
    subject: 'New listing near you',
    body: 'Hi Tom',
    authorName: 'Sara',
    agencyName: 'Alpha',
  };
  it('carries the unsubscribe link and header, and its own subject', () => {
    const m = buildConversationEmail({ ...base, unsubscribeUrl: 'https://web.test/unsubscribe?t=c.x.y' });
    expect(m.kind).toBe('marketing');
    expect(m.kind === 'marketing' && m.listUnsubscribeUrl).toBe('https://web.test/unsubscribe?t=c.x.y');
    expect(m.text).toContain('Unsubscribe: https://web.test/unsubscribe');
    expect(m.subject).toBe('New listing near you');
  });
  it('leaves a normal reply transactional', () => {
    expect(buildConversationEmail(base).kind).toBe('transactional');
  });
});

describe('limits and the dev allowlist', () => {
  it('reads every limit from config, with the agreed defaults', () => {
    expect(emailLimitsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ perAgentDay: 50, perAgencyDay: 200, perBatch: 20, repeatDays: 7, sendDelayMs: 500 });
    expect(emailLimitsFromEnv({ EMAIL_LIMIT_PER_BATCH: '5', EMAIL_SEND_DELAY_MS: '0' } as NodeJS.ProcessEnv)).toMatchObject({ perBatch: 5, sendDelayMs: 0 });
  });
  it('outside production sends only to the allowlist — and to nobody when it is unset', () => {
    const none = devAllowlist({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)!;
    expect(none('tom@example.test')).toBe(false);
    const some = devAllowlist({ NODE_ENV: 'development', EMAIL_DEV_ALLOWLIST: 'me@mine.test, @team.test' } as NodeJS.ProcessEnv)!;
    expect(some('ME@mine.test')).toBe(true);
    expect(some('anyone@team.test')).toBe(true);
    expect(some('client@gmail.com')).toBe(false);
  });
  it('is ignored in production', () => {
    expect(devAllowlist({ NODE_ENV: 'production', EMAIL_DEV_ALLOWLIST: 'me@mine.test' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
