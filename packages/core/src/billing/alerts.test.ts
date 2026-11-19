import { describe, expect, it } from 'vitest';
import { buildCreditUsageEmail } from '../email/team-notices';
import { creditLevel } from './alerts';

/** PLATFORM-PLAN 2.6. Once-per-level-per-period and owners-only are proven on the dev database. */
describe('creditLevel', () => {
  it('80 from four fifths, 100 when nothing is left, nothing below or with no credits', () => {
    expect(creditLevel(1000, 799.99)).toBeNull();
    expect(creditLevel(1000, 800)).toBe(80);
    expect(creditLevel(1000, 999.99)).toBe(80);
    expect(creditLevel(1000, 1000)).toBe(100);
    expect(creditLevel(1000, 1250)).toBe(100);
    expect(creditLevel(0, 5)).toBeNull();
  });
});

describe('buildCreditUsageEmail', () => {
  const base = { to: { email: 'o@x.au' }, from: { email: 'n@p.au', name: 'Platform' }, postalAddress: '1 St, Sydney NSW', credits: 1000, settingsUrl: 'https://agency.x/settings' };
  it('80%: what is left, from the figures given; 100%: AI paused, own sends untouched', () => {
    const at80 = buildCreditUsageEmail({ ...base, level: 80, left: 200 });
    expect(at80.subject).toBe("You've used 80% of your AI credits");
    expect(at80.text).toContain('200 of 1000 AI credits left');
    const at100 = buildCreditUsageEmail({ ...base, level: 100, left: 0 });
    expect(at100.subject).toBe('Your AI credits are used up');
    expect(at100.text).toContain('AI features are paused');
    expect(at100.html).toContain('https://agency.x/settings');
    expect(at100.tags).toEqual({ kind: 'credits-100' });
  });
  it('refuses without the sender footer (the same rule as every team notice)', () => {
    expect(() => buildCreditUsageEmail({ ...base, postalAddress: '', level: 80, left: 1 })).toThrow();
  });
});
