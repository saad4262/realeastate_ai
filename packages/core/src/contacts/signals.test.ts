import { describe, expect, it } from 'vitest';
import { agoWords, profileSignals, type ContactSignalFacts } from './signals';
import { durationWords } from './lead-summary';

const NOW = new Date('2026-11-06T10:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const NOTHING: ContactSignalFacts = {
  lastFromThemAt: null,
  lastFromThemChannel: null,
  lastFromUsAt: null,
  inbound7: 0,
  inbound30: 0,
  enquiries7: 0,
  enquiries30: 0,
  everActive: false,
  views7: 0,
  views30: 0,
  topView: null,
  unansweredLeadAt: null,
  matchingListings: 0,
  nextAction: null,
  nextActionAt: null,
};
const keys = (f: Partial<ContactSignalFacts>) => profileSignals({ ...NOTHING, ...f }, NOW).nudges.map((n) => n.key);

describe('hot, warm and quiet (ADR 0083 §8)', () => {
  it('nothing at all is no activity, with no nudges', () => {
    const s = profileSignals(NOTHING, NOW);
    expect(s.engagement).toBe('none');
    expect(s.nudges).toEqual([]);
  });

  it('an enquiry or a message this week is hot, and the reason names the figures', () => {
    const s = profileSignals({ ...NOTHING, enquiries7: 2, enquiries30: 2, views7: 1, views30: 1, everActive: true }, NOW);
    expect(s.engagement).toBe('hot');
    expect(s.why).toBe('2 enquiries, 1 listing view in the last 7 days.');
    expect(profileSignals({ ...NOTHING, inbound7: 1, inbound30: 1, everActive: true }, NOW).engagement).toBe('hot');
  });

  it('views alone need three in a week to be hot: two is warm', () => {
    expect(profileSignals({ ...NOTHING, views7: 3, views30: 3 }, NOW).engagement).toBe('hot');
    expect(profileSignals({ ...NOTHING, views7: 2, views30: 2 }, NOW).engagement).toBe('warm');
  });

  it('something this month is warm; history with nothing this month is quiet', () => {
    expect(profileSignals({ ...NOTHING, inbound30: 1, everActive: true }, NOW).engagement).toBe('warm');
    const quiet = profileSignals({ ...NOTHING, everActive: true, lastFromThemAt: daysAgo(45), lastFromThemChannel: 'email' }, NOW);
    expect(quiet.engagement).toBe('quiet');
    expect(quiet.why).toBe('Last heard from 45 days ago.');
  });
});

describe('what to do next', () => {
  it('waiting on a reply only when their last word is newer than ours, pointing at that channel', () => {
    const facts = { lastFromThemAt: hoursAgo(3), lastFromThemChannel: 'sms' as const, lastFromUsAt: hoursAgo(5), everActive: true };
    const s = profileSignals({ ...NOTHING, ...facts }, NOW);
    expect(s.nudges[0]).toEqual({ key: 'reply', text: 'Waiting on a reply: their text came 3 hours ago', tab: 'sms' });
    expect(keys({ ...facts, lastFromUsAt: hoursAgo(1) })).not.toContain('reply');
    expect(profileSignals({ ...NOTHING, ...facts, lastFromThemChannel: 'email' }, NOW).nudges[0]!.tab).toBe('emails');
  });

  it('an overdue next action says so; one still ahead does not', () => {
    expect(keys({ nextAction: 'Call them', nextActionAt: daysAgo(2) })).toContain('overdue');
    expect(keys({ nextAction: 'Call them', nextActionAt: new Date(NOW.getTime() + 3_600_000) })).not.toContain('overdue');
  });

  it('an unanswered lead, matching listings and a repeat view each have their own line', () => {
    expect(keys({ unansweredLeadAt: daysAgo(2) })).toEqual(['lead']);
    const one = profileSignals({ ...NOTHING, matchingListings: 1 }, NOW).nudges[0]!;
    expect(one.text).toBe('1 live listing fits their brief');
    expect(profileSignals({ ...NOTHING, matchingListings: 3 }, NOW).nudges[0]!.text).toBe('3 live listings fit their brief');
    expect(keys({ topView: { address: '12 Rose Court', views: 1 } })).toEqual([]);
    expect(profileSignals({ ...NOTHING, topView: { address: '12 Rose Court', views: 5 } }, NOW).nudges[0]!.text).toBe('Opened 12 Rose Court 5 times this week');
  });

  it('no contact for a month is said only of somebody who has history', () => {
    expect(keys({ everActive: true, lastFromUsAt: daysAgo(40) })).toEqual(['quiet']);
    expect(keys({ everActive: true, lastFromUsAt: daysAgo(10) })).toEqual([]);
    expect(keys({ everActive: false, lastFromUsAt: daysAgo(40) })).toEqual([]);
  });
});

describe('the words for time', () => {
  it('agoWords', () => {
    expect(agoWords(new Date(NOW.getTime() - 30_000), NOW)).toBe('1 minute');
    expect(agoWords(hoursAgo(1), NOW)).toBe('1 hour');
    expect(agoWords(hoursAgo(47), NOW)).toBe('47 hours');
    expect(agoWords(daysAgo(3), NOW)).toBe('3 days');
    // A clock ahead of the database never reads as negative.
    expect(agoWords(new Date(NOW.getTime() + 60_000), NOW)).toBe('1 minute');
  });
  it('durationWords', () => {
    expect(durationWords(20)).toBe('under a minute');
    expect(durationWords(45 * 60)).toBe('45 min');
    expect(durationWords(2 * 3600 + 600)).toBe('2 h 10 min');
    expect(durationWords(3600)).toBe('1 h');
    expect(durationWords(3 * 86_400)).toBe('3 days');
  });
});
