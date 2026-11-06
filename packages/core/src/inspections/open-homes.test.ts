import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import {
  checkOpenHomeSlots,
  defaultOpenHomeDate,
  openHomeDay,
  openHomeInputSchema,
  openHomeNextWeek,
  openHomeRange,
  openHomeSlots,
  parseOpenHomesCell,
  type ExistingOpenHome,
} from './open-home-rules';
import { addOpenHomes, copyOpenHomeNextWeek, openHomesForListing, removeOpenHome, updateOpenHome, upcomingOpenHomeCount } from './open-homes';

const MELB = 'Australia/Melbourne';
const NOW = new Date('2026-11-06T01:00:00Z'); // Friday 6 Nov, noon in Melbourne
const ctx = (over: Partial<Parameters<typeof checkOpenHomeSlots>[1]> = {}) => ({ kind: 'open' as const, existing: [] as ExistingOpenHome[], now: NOW, timeZone: MELB, place: 'Melbourne', confirmedHours: false, ...over });
const at = (date: string, start: string, minutes = 30, weeks = 1) => openHomeSlots({ date, start, minutes, weeks }, MELB)!;
const row = (id: string, date: string, start: string, kind: ExistingOpenHome['kind'] = 'open'): ExistingOpenHome => ({ id, kind, ...at(date, start)[0]! });

describe('open-home times are on the property’s clock', () => {
  it('10:00 am Saturday in Melbourne is the instant before midnight UTC on Friday, and prints as 10:00 am', () => {
    const [s] = at('2026-11-14', '10:00');
    expect(s!.startsAt.toISOString()).toBe('2026-11-13T23:00:00.000Z');
    expect(openHomeDay(s!.startsAt, MELB)).toBe('Sat 14 Nov 2026');
    expect(openHomeRange(s!, MELB)).toBe('10:00 – 10:30 am');
  });
  it('the same words in Perth are a different instant', () => {
    expect(openHomeSlots({ date: '2026-11-14', start: '10:00', minutes: 30 }, 'Australia/Perth')![0]!.startsAt.toISOString()).toBe('2026-11-14T02:00:00.000Z');
  });
  it('a weekly repeat keeps its wall-clock hour across daylight saving', () => {
    const slots = openHomeSlots({ date: '2027-03-27', start: '10:00', minutes: 30, weeks: 3 }, MELB)!; // the clocks change on 4 April
    expect(slots.map((s) => openHomeRange(s, MELB))).toEqual(['10:00 – 10:30 am', '10:00 – 10:30 am', '10:00 – 10:30 am']);
    expect(slots[2]!.startsAt.getTime() - slots[1]!.startsAt.getTime()).toBe(7 * 86_400_000 + 3_600_000);
  });
  it('a range across noon names both', () => {
    expect(openHomeRange(at('2026-11-14', '11:45')[0]!, MELB)).toBe('11:45 am – 12:15 pm');
  });
  it('the form starts on the coming Saturday, or the next when that is today or tomorrow', () => {
    expect(defaultOpenHomeDate(new Date('2026-11-04T01:00:00Z'), MELB)).toBe('2026-11-07'); // Wednesday
    expect(defaultOpenHomeDate(NOW, MELB)).toBe('2026-11-14'); // Friday
    expect(defaultOpenHomeDate(new Date('2026-11-07T01:00:00Z'), MELB)).toBe('2026-11-14'); // Saturday
  });
  it('Next week is the same wall-clock time 7 days on', () => {
    expect(openHomeNextWeek(at('2026-11-14', '10:00')[0]!, MELB)).toEqual({ date: '2026-11-21', start: '10:00', minutes: 30 });
  });
});

describe('the input', () => {
  const good = { kind: 'open', date: '2026-11-14', start: '10:00', minutes: 30 } as const;
  it('10 minutes to 4 hours, in the agent’s words', () => {
    expect(openHomeInputSchema.safeParse(good).success).toBe(true);
    for (const minutes of [9, 241]) expect(openHomeInputSchema.safeParse({ ...good, minutes }).error?.issues[0]?.message).toMatch(/between 10 minutes and 4 hours/);
  });
  it('at most 6 weeks, and nothing it does not know', () => {
    expect(openHomeInputSchema.safeParse({ ...good, weeks: 7 }).success).toBe(false);
    expect(openHomeInputSchema.safeParse({ ...good, listingId: 'x' }).success).toBe(false);
  });
});

describe('what is refused', () => {
  it('a time that has passed, and one over 6 months away', () => {
    expect(checkOpenHomeSlots(at('2026-11-05', '10:00'), ctx())).toMatchObject({ ok: false, message: expect.stringMatching(/already passed/) });
    expect(checkOpenHomeSlots(at('2027-06-01', '10:00'), ctx())).toMatchObject({ ok: false, message: expect.stringMatching(/6 months/) });
  });
  it('an overlap names what it overlaps; touching end to start is allowed', () => {
    const existing = [row('a', '2026-11-14', '10:15')];
    expect(checkOpenHomeSlots(at('2026-11-14', '10:00'), ctx({ existing }))).toMatchObject({ ok: false, message: expect.stringMatching(/Sat 14 Nov 2026 overlaps the open home at 10:15 – 10:45 am/) });
    expect(checkOpenHomeSlots(at('2026-11-14', '09:45'), ctx({ existing }))).toEqual({ ok: true });
    expect(checkOpenHomeSlots(at('2026-11-14', '10:45'), ctx({ existing }))).toEqual({ ok: true });
  });
  it('a repeat is all or nothing, naming the week that clashes', () => {
    const existing = [row('a', '2026-11-28', '10:00')];
    expect(checkOpenHomeSlots(at('2026-11-14', '10:00', 30, 4), ctx({ existing }))).toMatchObject({ ok: false, message: expect.stringMatching(/^Sat 28 Nov 2026 overlaps/) });
  });
  it('the 21st upcoming time', () => {
    const existing = Array.from({ length: 20 }, (_, i) => row(String(i), '2026-11-14', `0${i % 10}:00`));
    expect(checkOpenHomeSlots(at('2026-12-14', '10:00'), ctx({ existing }))).toMatchObject({ ok: false, message: expect.stringMatching(/20 upcoming/) });
    expect(checkOpenHomeSlots(at('2026-12-14', '10:00'), ctx({ existing: existing.slice(1) }))).toEqual({ ok: true });
  });
  it('one upcoming auction, and it cannot repeat', () => {
    const existing = [row('a', '2026-11-28', '11:00', 'auction')];
    expect(checkOpenHomeSlots(at('2026-12-05', '11:00'), ctx({ kind: 'auction', existing }))).toMatchObject({ ok: false, message: expect.stringMatching(/already has an auction on Sat 28 Nov 2026/) });
    expect(checkOpenHomeSlots(at('2026-12-05', '11:00', 30, 2), ctx({ kind: 'auction' }))).toMatchObject({ ok: false, message: expect.stringMatching(/cannot repeat/) });
    expect(checkOpenHomeSlots(at('2026-12-05', '11:00'), ctx({ existing }))).toEqual({ ok: true });
  });
  it('outside 7 am to 8 pm asks first, on the property’s clock, and saves once answered', () => {
    expect(checkOpenHomeSlots(at('2026-11-14', '21:30'), ctx())).toEqual({ ok: false, confirm: true, message: "That's 9:30 pm in Melbourne. Is this right?" });
    expect(checkOpenHomeSlots(at('2026-11-14', '19:45'), ctx())).toEqual({ ok: false, confirm: true, message: 'That runs until 8:15 pm in Melbourne. Is this right?' });
    expect(checkOpenHomeSlots(at('2026-11-14', '06:30'), ctx())).toEqual({ ok: false, confirm: true, message: "That's 6:30 am in Melbourne. Is this right?" });
    expect(checkOpenHomeSlots(at('2026-11-14', '21:30'), ctx({ confirmedHours: true }))).toEqual({ ok: true });
    expect(checkOpenHomeSlots(at('2026-11-14', '19:30'), ctx())).toEqual({ ok: true }); // ends at 8:00 pm exactly
  });
});

describe('the import’s open_homes cell', () => {
  it('reads each time on the property’s clock', () => {
    expect(parseOpenHomesCell('2026-11-14 10:00-10:30; 2026-11-21 10:00-10:30', 'VIC')).toEqual({
      slots: [
        { startsAt: '2026-11-13T23:00:00.000Z', endsAt: '2026-11-13T23:30:00.000Z' },
        { startsAt: '2026-11-20T23:00:00.000Z', endsAt: '2026-11-20T23:30:00.000Z' },
      ],
      problems: [],
    });
    expect(parseOpenHomesCell('2026-11-14 10:00-10:30', 'WA').slots[0]!.startsAt).toBe('2026-11-14T02:00:00.000Z');
  });
  it('names what it cannot read and keeps the rest; never guesses', () => {
    const out = parseOpenHomesCell('14/11 10am; 2026-11-21 10:30-10:00; 2026-11-28 10:00-10:30', 'VIC');
    expect(out.slots).toHaveLength(1);
    expect(out.problems).toHaveLength(2);
    expect(out.problems[0]).toMatch(/“14\/11 10am” isn't in the expected format/);
  });
  it('an empty cell is nothing', () => {
    expect(parseOpenHomesCell('', 'VIC')).toEqual({ slots: [], problems: [] });
  });
});

/** Every new endpoint needs a permission test (CLAUDE.md #2): the agency and the listing link decide, never the caller. */
const OURS = '11111111-1111-1111-1111-111111111111';
const THEIRS = '22222222-2222-2222-2222-222222222222';
const LISTING = '33333333-3333-3333-3333-333333333333';
const TIME = '44444444-4444-4444-4444-444444444444';
const ME = '55555555-5555-5555-5555-555555555555';

/** Answers the target's read from `agencyId`, every other read with no rows, and records the writes. */
function fakeDb(agencyId: string | null, rows: unknown[] = []) {
  const writes: string[] = [];
  let reads = 0;
  const select = () => {
    reads += 1;
    const answer = reads === 1 ? (agencyId ? [{ agencyId, status: 'live', state: 'VIC' }] : []) : rows;
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'for']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res);
    return chain;
  };
  const write = (name: string) => () => {
    writes.push(name);
    const chain: Record<string, unknown> = {};
    for (const m of ['values', 'set', 'where', 'returning']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve([{ kind: 'open' }]).then(res);
    return chain;
  };
  const db: Record<string, unknown> = { select, insert: write('insert'), update: write('update'), delete: write('delete') };
  db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db: db as unknown as Db, writes, reads: () => reads };
}

const owner: Actor = { userId: ME, agencyId: OURS, membershipRole: 'owner' };
const named: Actor = { userId: ME, agencyId: OURS, membershipRole: 'agent', listingAgentOf: [LISTING] };
const notNamed: Actor = { userId: ME, agencyId: OURS, membershipRole: 'agent', listingAgentOf: [] };
const input = { kind: 'open', date: '2026-11-14', start: '10:00', minutes: 30 } as const;

describe('who may set a listing’s open homes', () => {
  const calls: [string, (db: Db, actor: Actor) => Promise<unknown>][] = [
    ['read', (db, a) => openHomesForListing(db, a, LISTING, NOW)],
    ['add', (db, a) => addOpenHomes(db, a, LISTING, input, { now: NOW })],
    ['change', (db, a) => updateOpenHome(db, a, LISTING, TIME, input, { now: NOW })],
    ['remove', (db, a) => removeOpenHome(db, a, LISTING, TIME, { now: NOW })],
    ['copy', (db, a) => copyOpenHomeNextWeek(db, a, LISTING, TIME, { now: NOW })],
  ];
  it.each(calls)('%s: another agency’s listing reads as not found and writes nothing', async (_name, call) => {
    const { db, writes } = fakeDb(THEIRS);
    await expect(call(db, owner)).rejects.toThrow('That listing could not be found');
    expect(writes).toEqual([]);
  });
  it.each(calls)('%s: an agent not on the listing reads the same', async (_name, call) => {
    const { db, writes } = fakeDb(OURS);
    await expect(call(db, notNamed)).rejects.toThrow('That listing could not be found');
    expect(writes).toEqual([]);
  });
  it.each(calls)('%s: a listing that does not exist reads the same', async (_name, call) => {
    const { db, writes } = fakeDb(null);
    await expect(call(db, owner)).rejects.toThrow('That listing could not be found');
    expect(writes).toEqual([]);
  });
  it('the owner and the agent named on it may add', async () => {
    for (const actor of [owner, named]) {
      const { db, writes } = fakeDb(OURS);
      await expect(addOpenHomes(db, actor, LISTING, input, { now: NOW })).resolves.toEqual({ added: 1 });
      expect(writes).toEqual(['insert']);
    }
  });
  it('an auction writes its date to the listing in the same transaction; an open home does not', async () => {
    const { db, writes } = fakeDb(OURS);
    await addOpenHomes(db, owner, LISTING, { ...input, kind: 'auction' }, { now: NOW });
    expect(writes).toEqual(['insert', 'update']);
  });
  it('a refused time writes nothing', async () => {
    const { db, writes } = fakeDb(OURS);
    await expect(addOpenHomes(db, owner, LISTING, { ...input, date: '2026-01-01' }, { now: NOW })).rejects.toThrow(/already passed/);
    expect(writes).toEqual([]);
  });
  it('the question about the hour is marked, so the form can ask it', async () => {
    const { db } = fakeDb(OURS);
    await expect(addOpenHomes(db, owner, LISTING, { ...input, start: '21:30' }, { now: NOW })).rejects.toMatchObject({ confirm: true });
  });
  it('a time on another listing is not touched: nothing there reads as gone', async () => {
    const { db, writes } = fakeDb(OURS);
    await expect(updateOpenHome(db, owner, LISTING, TIME, input, { now: NOW })).rejects.toThrow(/no longer on this listing/);
    expect(writes).toEqual([]);
  });
});

describe('query counts', () => {
  it('the tab reads three statements, however many times there are', async () => {
    const { db, reads } = fakeDb(OURS, [row('a', '2026-11-14', '10:00'), row('b', '2026-11-21', '10:00')]);
    await openHomesForListing(db, owner, LISTING, NOW);
    expect(reads()).toBe(3);
  });
  it('the tab’s count is one', async () => {
    const { db, reads } = fakeDb(OURS, []);
    await upcomingOpenHomeCount(db, LISTING, NOW);
    expect(reads()).toBe(1);
  });
});
