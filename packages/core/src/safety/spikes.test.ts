import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { buildSendsPausedEmail } from '../email/team-notices';
import { isSpike, resumeAgencySends, spikeCaps } from './spikes';

/** PLATFORM-PLAN 3.7: when an agency's hour is a spike, and who may resume its sends. Proven end to end on dev. */
describe('isSpike', () => {
  const week = (perHour: number) => perHour * 167;
  it('a quiet agency that suddenly sends 80 texts in an hour: spike', () => {
    expect(isSpike(80, 0, 60, 3)).toBe(true);
  });
  it('an agency that usually sends 40 an hour sending 80: not a spike (under 3x)', () => {
    expect(isSpike(80, week(40), 60, 3)).toBe(false);
    expect(isSpike(121, week(40), 60, 3)).toBe(true);
  });
  it('under the floor is never a spike, however quiet the week was', () => {
    expect(isSpike(59, 0, 60, 3)).toBe(false);
  });
});

describe('spikeCaps', () => {
  it('defaults: 3x, 60 texts, 300 emails, $5 of AI; env overrides; nonsense falls back', () => {
    expect(spikeCaps({} as NodeJS.ProcessEnv)).toEqual({ multiplier: 3, sms: 60, email: 300, aiUsd: 5 });
    expect(spikeCaps({ SPIKE_MULTIPLIER: '4', SPIKE_FLOOR_SMS_PER_HOUR: '100' } as unknown as NodeJS.ProcessEnv)).toMatchObject({ multiplier: 4, sms: 100 });
    expect(spikeCaps({ SPIKE_MULTIPLIER: '-1', SPIKE_FLOOR_AI_USD_PER_HOUR: 'lots' } as unknown as NodeJS.ProcessEnv)).toMatchObject({ multiplier: 3, aiUsd: 5 });
  });
});

describe('resumeAgencySends', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  it('an agent, an assistant or a read-only member may not resume', async () => {
    for (const membershipRole of ['agent', 'assistant', 'read_only'] as const) {
      await expect(resumeAgencySends({} as Db, { userId: 'u', agencyId: A, membershipRole })).rejects.toThrow(/owner or admin/);
    }
  });
});

describe('buildSendsPausedEmail', () => {
  it('says what was seen, that nothing was lost, and where to resume; carries the sender footer', () => {
    const m = buildSendsPausedEmail({ to: { email: 'o@a.test' }, from: { email: 'n@p.test', name: 'Platform' }, postalAddress: '1 St, Sydney NSW 2000', reason: "Far above this agency's usual: 80 texts in the last hour.", settingsUrl: 'https://agency.x/settings' });
    expect(m.subject).toMatch(/paused/);
    expect(m.text).toMatch(/80 texts/);
    expect(m.text).toMatch(/Nothing was deleted/);
    expect(m.text).toMatch(/https:\/\/agency\.x\/settings/);
    expect(m.text).toMatch(/1 St, Sydney/);
  });
});
