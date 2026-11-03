import { describe, expect, it } from 'vitest';
import { deriveProfile, PROFILE_FIELDS, profileLine, profileOverridesSchema, sourceWords, type Signals } from './derive';
import { editProfile, forgetProfile, loadProfile, ProfileError } from './profile';

const d = (s: string) => new Date(`${s}T01:00:00Z`);
const signals: Signals = {
  savedSearches: [
    { at: d('2026-11-01'), suburb: 'pakenham', channel: 'sale', priceTo: 800_000, bedrooms: 3 },
    { at: d('2026-10-01'), suburb: 'Officer', channel: 'sale', priceTo: 750_000, bedrooms: 3, propertyType: 'House' },
  ],
  chats: [{ at: d('2026-11-02'), suburb: 'Berwick', channel: 'sale', priceTo: 900_000 }],
  shortlisted: [
    { at: d('2026-11-01'), suburb: 'Pakenham', channel: 'sale', propertyType: 'House' },
    { at: d('2026-11-01'), suburb: 'Officer', channel: 'sale', propertyType: 'House' },
    { at: d('2026-11-01'), suburb: 'Pakenham', channel: 'sale', propertyType: 'Townhouse' },
  ],
  watched: [{ at: d('2026-11-01'), suburb: 'Pakenham' }],
};

describe('Personal Property AI — counted from the buyer’s own actions (ADR 0080, C4 decision 5)', () => {
  it('suburbs, buy or rent, bedrooms and types by count; the budget from the newest saved search before any chat', () => {
    const p = deriveProfile(signals);
    expect(p.suburbs).toEqual({ value: ['Pakenham', 'Officer', 'Berwick'], by: 'learnt', sources: [{ kind: 'saved_search', count: 2 }, { kind: 'shortlist', count: 3 }, { kind: 'watch', count: 1 }, { kind: 'chat', count: 1 }] });
    expect(p.channel?.value).toBe('sale');
    expect(p.priceTo).toEqual({ value: 800_000, by: 'learnt', sources: [{ kind: 'saved_search', count: 1 }] });
    expect(p.bedrooms?.value).toBe(3);
    expect(p.propertyTypes?.value).toEqual(['House', 'Townhouse']);
    expect(profileLine(p)).toBe('looks in Pakenham, Officer, Berwick; buying; up to $800,000; 3+ bedrooms; house or townhouse');
  });

  it('a tie between buying and renting is no fact, not a coin toss; nothing done means nothing known', () => {
    const tie = deriveProfile({ savedSearches: [{ at: d('2026-11-01'), channel: 'sale' }, { at: d('2026-11-02'), channel: 'rent' }], chats: [], shortlisted: [], watched: [] });
    expect(tie.channel).toBeNull();
    const empty = deriveProfile({ savedSearches: [], chats: [], shortlisted: [], watched: [] });
    expect(PROFILE_FIELDS.every((f) => empty[f] === null)).toBe(true);
    expect(profileLine(empty)).toBeNull();
  });

  it('the buyer’s edit wins, and a field they removed stays removed', () => {
    const p = deriveProfile(signals, { suburbs: ['Clyde North'], priceTo: null });
    expect(p.suburbs).toEqual({ value: ['Clyde North'], by: 'you', sources: [{ kind: 'you', count: 1 }] });
    expect(p.priceTo).toBeNull();
    expect(sourceWords(p.suburbs!.sources)).toBe('set by you');
  });

  it('says where each fact came from, in plain words', () => {
    expect(sourceWords([{ kind: 'saved_search', count: 2 }, { kind: 'shortlist', count: 3 }])).toBe('from 2 saved searches and 3 shortlisted homes');
    expect(sourceWords([{ kind: 'chat', count: 1 }])).toBe('from 1 chat with the guide');
  });
});

describe('privacy, by construction (the user’s rules)', () => {
  it('five fields about the home — none about the person', () => {
    expect([...PROFILE_FIELDS]).toEqual(['suburbs', 'channel', 'priceTo', 'bedrooms', 'propertyTypes']);
  });

  it('an edit carrying anything else — age, income, family — is refused whole', () => {
    for (const extra of [{ age: 34 }, { income: 120000 }, { family: 'two kids' }, { suburbs: ['Pakenham'], ethnicity: 'x' }]) {
      expect(profileOverridesSchema.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('a signed-out actor (or anyone not the owner) reads and changes nothing', async () => {
    for (const call of [() => loadProfile({} as never, { userId: '' }), () => editProfile({} as never, { userId: '' }, {}), () => forgetProfile({} as never, { userId: '' })]) {
      await expect(call()).rejects.toBeInstanceOf(ProfileError);
    }
  });
});
