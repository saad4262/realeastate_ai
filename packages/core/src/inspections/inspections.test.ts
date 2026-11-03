import { describe, expect, it } from 'vitest';
import { checklistKind, CHECKLISTS, inspectionNotePatchSchema, readChecks } from './checklist';
import { busiestDay, clampSettings, kmText, planAuto, planChosen, planIcs, planQuery, routeUrl, walkDay, type PlanHome, type PlanSession } from './plan';
import { hasExif, photoType, stripPhotoMetadata, PhotoBytesError } from './photo-bytes';
import { checkInspectionSummary, conditionWordsSupported, notebookRecord, planToolResult } from './summary';
import { deleteAllNotebooks, loadNotebook, NotebookError, recordPhoto, saveNotebook } from './notes';
import type { DbOrTx } from '@repo/db';

const TZ = 'Australia/Melbourne';
// Saturday 14 November 2026, Melbourne (UTC+11 in daylight saving).
const at = (hhmm: string, day = '2026-11-14') => new Date(`${day}T${hhmm}:00+11:00`);
const session = (id: string, from: string, to: string, day?: string): PlanSession => ({ id, startsAt: at(from, day), endsAt: at(to, day) });
const home = (listingId: string, address: string, sessions: PlanSession[]): PlanHome => ({ listingId, address, mapAddress: `${address} VIC 3809`, state: 'VIC', price: 'Offers over $780,000', bedrooms: 4, propertyType: 'House', sessions });
const metres: Record<string, number> = { 'a|b': 1200, 'b|c': 3800, 'c|d': 2100, 'a|c': 4300, 'b|d': 5000, 'a|d': 6000 };
const distances = (x: string, y: string) => metres[[x, y].sort().join('|')] ?? null;
const settings = clampSettings({});

// The mock's Saturday: 7 Test Road 9:30, 14 Station Street 10:15, 3 Sample Way 10:30–10:50 or 12:30, 22 Demo Avenue 11:45.
const A = home('a', '7 Test Road, Officer', [session('a1', '09:30', '10:00'), session('a2', '13:00', '13:30')]);
const B = home('b', '14 Station Street, Officer', [session('b1', '10:15', '10:45')]);
const C = home('c', '3 Sample Way, Pakenham', [session('c1', '10:30', '10:50'), session('c2', '12:30', '13:00')]);
const D = home('d', '22 Demo Avenue, Pakenham', [session('d1', '11:45', '12:15')]);

describe('walkDay (decision 2: your time inside, your gap, the agent’s window)', () => {
  it('marks the mock’s 3 Sample Way at 10:30 tight: arriving 10:45, five minutes left', () => {
    const stops = walkDay([{ home: A, session: A.sessions[0]! }, { home: B, session: B.sessions[0]! }, { home: C, session: C.sessions[0]! }], settings, distances, TZ);
    expect(stops.map((s) => s.status)).toEqual(['start', 'fits', 'tight']);
    expect(stops[2]!.arriveAt).toEqual(at('10:45'));
    expect(stops[2]!.minutesLeft).toBe(5);
    expect(stops[2]!.metresFromPrevious).toBe(3800);
    expect(stops[2]!.otherTimes.map((o) => o.id)).toEqual(['c2']);
  });

  it('says "can’t make it" when nothing is left, names the stop in the way, and does not let it hold up the next', () => {
    const E = home('e', '5 Placeholder Street, Officer', [session('e1', '10:00', '10:20')]);
    const stops = walkDay([{ home: A, session: A.sessions[0]! }, { home: E, session: E.sessions[0]! }, { home: B, session: B.sessions[0]! }], settings, distances, TZ);
    // Leave 7 Test Road at 9:40, + 20 min → 10:00: E's window opens then, so E fits; B after E: leave 10:10 + 20 = 10:30.
    expect(stops.map((s) => s.status)).toEqual(['start', 'fits', 'fits']);
    const clash = walkDay([{ home: A, session: A.sessions[0]! }, { home: E, session: session('e2', '09:30', '09:50') }], settings, distances, TZ);
    expect(clash[1]!.status).toBe('cant');
    expect(clash[1]!.conflictsWith).toBe('a');
  });

  it('uses the buyer’s own gap and time inside', () => {
    const stops = walkDay([{ home: A, session: A.sessions[0]! }, { home: B, session: B.sessions[0]! }, { home: C, session: C.sessions[0]! }], clampSettings({ gapMinutes: 10, insideMinutes: 5 }), distances, TZ);
    // Leave B at 10:20 + 10 → 10:30: all of C's 20 minutes.
    expect(stops[2]!.status).toBe('fits');
    expect(stops[2]!.minutesLeft).toBe(20);
  });

  it('only accepts the offered settings', () => {
    expect(clampSettings({ gapMinutes: 7, insideMinutes: 999 })).toEqual({ gapMinutes: 20, insideMinutes: 10 });
  });
});

describe('planAuto (the planner picks the times)', () => {
  it('takes 3 Sample Way’s later time so nothing is tight, as the mock’s guide answer does', () => {
    const plan = planAuto([A, B, C, D], { day: '2026-11-14', settings, distances, timeZone: TZ });
    expect(plan.stops.map((s) => s.session.id)).toEqual(['a1', 'b1', 'd1', 'c2']);
    expect(plan.stops.every((s) => s.status === 'start' || s.status === 'fits')).toBe(true);
    expect(plan.notThisDay).toEqual([]);
  });

  it('keeps a home with no time that day, with its next time — never drops it', () => {
    const F = home('f', '9 Mock Close, Beaconsfield', [session('f1', '17:30', '18:00', '2026-11-19')]);
    const plan = planAuto([A, F], { day: '2026-11-14', settings, distances, timeZone: TZ });
    expect(plan.notThisDay).toEqual([{ home: F, reason: 'no_time_this_day', nextTime: F.sessions[0] }]);
  });

  it('picks the day most of the homes are open', () => {
    const F = home('f', '9 Mock Close', [session('f1', '17:30', '18:00', '2026-11-19')]);
    expect(busiestDay([A, B, F], TZ)).toBe('2026-11-14');
  });
});

describe('planChosen (the plan’s link)', () => {
  it('keeps a home whose chosen time the agent removed, as "Not this day" with its next time', () => {
    const plan = planChosen([A, B, C], ['a1', 'b1', 'gone'], { settings, distances, timeZone: TZ });
    expect(plan.stops.map((s) => s.home.listingId)).toEqual(['a', 'b']);
    expect(plan.notThisDay).toEqual([{ home: C, reason: 'time_removed', nextTime: C.sessions[0] }]);
    expect(new URLSearchParams(planQuery(plan)).get('l')).toBe('a,b,c');
  });
});

describe('the calendar file and the route (decision 3)', () => {
  const plan = planAuto([A, B, D], { day: '2026-11-14', settings, distances, timeZone: TZ });

  it('is one calendar with an event per stop, in the agent’s times, UTC', () => {
    const ics = planIcs(plan, { now: new Date('2026-11-10T00:00:00Z'), listingUrl: (id) => `https://site.com.au/listing/${id}` });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain('DTSTART:20261113T223000Z');
    expect(ics).toContain('UID:inspection-a1@property-platform');
    expect(ics).toContain('SUMMARY:Open home: 7 Test Road\\, Officer');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('opens Google Maps with the stops in order', () => {
    const url = new URL(routeUrl(plan)!);
    expect(url.searchParams.get('origin')).toBe('7 Test Road, Officer VIC 3809');
    expect(url.searchParams.get('waypoints')).toBe('14 Station Street, Officer VIC 3809');
    expect(url.searchParams.get('destination')).toBe('22 Demo Avenue, Pakenham VIC 3809');
  });

  it('writes distances as straight-line km, rounded to 100 m', () => {
    expect(kmText(3849)).toBe('3.8 km');
    expect(kmText(null)).toBeNull();
  });

  it('gives the guide code-written times and distances, and the plan’s link', () => {
    const r = planToolResult(planAuto([A, B, C], { day: '2026-11-14', settings, distances, timeZone: TZ }));
    expect(r.day).toBe('Saturday 14 November');
    expect(r.stops[0]).toBe('9:30 am – 10:00 am: 7 Test Road, Officer.');
    expect(r.stops[1]).toContain('1.2 km in a straight line');
    expect(r.planPath).toMatch(/^\/inspections\?l=/);
    expect(r.rules).toMatch(/never estimate a driving time/);
  });
});

describe('the checklist (decision 7)', () => {
  it('gives apartments the building and strata items', () => {
    expect(checklistKind('Apartment')).toBe('apartment');
    expect(checklistKind('House')).toBe('house');
    expect(CHECKLISTS.apartment.some((i) => i.key === 'strata_records')).toBe(true);
    expect(CHECKLISTS.house.some((i) => i.key === 'strata_records')).toBe(false);
  });

  it('reads back stored marks, leaving out what no longer parses', () => {
    expect(readChecks({ roof_gutters: { mark: 'fine' }, junk: { mark: 'fine' }, floors: { mark: 'maybe' } })).toEqual({ roof_gutters: { mark: 'fine' } });
  });

  it('refuses an empty save and an unknown item', () => {
    expect(inspectionNotePatchSchema.safeParse({}).success).toBe(false);
    expect(inspectionNotePatchSchema.safeParse({ checks: { nope: { mark: 'fine' } } }).success).toBe(false);
    expect(inspectionNotePatchSchema.safeParse({ notes: 'Backyard bigger than it looks' }).success).toBe(true);
  });
});

/** A JPEG with an APP0, an Exif APP1 carrying "GPS", a comment, then the scan. */
function jpegWithExif(): Uint8Array {
  const seg = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([0xff, 0xd8, ...seg(0xe0, ascii('JFIF\0')), ...seg(0xe1, [...ascii('Exif\0\0'), ...ascii('GPS-37.8,145.4')]), ...seg(0xfe, ascii('comment')), 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
}

describe('photo metadata (decision 8)', () => {
  it('removes Exif (where the GPS is) and comments from a JPEG, and keeps the picture', () => {
    const src = jpegWithExif();
    expect(hasExif(src)).toBe(true);
    const out = stripPhotoMetadata(src);
    expect(out.type.ext).toBe('jpg');
    expect(hasExif(out.bytes)).toBe(false);
    expect(Buffer.from(out.bytes).includes(Buffer.from('GPS'))).toBe(false);
    expect(Buffer.from(out.bytes).includes(Buffer.from('JFIF'))).toBe(true);
    expect([...out.bytes.slice(-8)]).toEqual([...src.slice(-8)]);
  });

  it('removes a PNG’s text and Exif chunks', () => {
    const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [1, 2, 3]), ...chunk('tEXt', [71, 80, 83]), ...chunk('eXIf', [1]), ...chunk('IDAT', [9]), ...chunk('IEND', [])]);
    const out = stripPhotoMetadata(png).bytes;
    const text = Buffer.from(out).toString('latin1');
    expect(text).toContain('IHDR');
    expect(text).toContain('IDAT');
    expect(text).not.toContain('tEXt');
    expect(text).not.toContain('eXIf');
  });

  it('knows a file by its bytes, not its name', () => {
    expect(photoType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(() => stripPhotoMetadata(new TextEncoder().encode('GIF89a'))).toThrow(PhotoBytesError);
  });
});

describe('the summary’s checks (decision 9)', () => {
  const record = notebookRecord('N1', {
    home: { listingId: 'a', address: '7 Test Road, Officer', suburb: 'Officer', state: 'VIC', propertyType: 'House', kind: 'house', isPublic: true },
    checks: { wall_cracks: { mark: 'issue', note: 'Long crack above the garage door' }, roof_gutters: { mark: 'fine' } },
    notes: 'Council rates $2,140 a year (agent). Settle in 60 days.',
  });

  it('builds the record from the buyer’s own marks and words', () => {
    expect(record.text).toContain('Marked Issue: Cracks in walls, paths or ceilings ("Long crack above the garage door")');
    expect(record.text).toContain('Marked Looks fine: Roof and gutters');
    expect(record.text).toContain('$2,140');
  });

  it('keeps a cited line with the buyer’s own figure; drops a verdict, an invented figure and a condition they did not write', () => {
    const kept = checkInspectionSummary(
      [
        { text: 'At 7 Test Road you noted council rates of $2,140 a year [N1].', refs: ['N1'] },
        { text: '7 Test Road is the best of the homes you saw.', refs: ['N1'] },
        { text: 'Expect about $5,000 to fix the crack.', refs: ['N1'] },
        { text: 'The crack above the garage suggests the house is not structurally sound.', refs: ['N1'] },
        { text: 'You marked the roof and gutters as looking fine.', refs: ['N9'] },
      ],
      [record],
    );
    expect(kept).toEqual([{ text: 'At 7 Test Road you noted council rates of $2,140 a year.', refs: ['N1'] }]);
  });

  it('allows a condition word the buyer wrote themselves', () => {
    expect(conditionWordsSupported('You noted a leak under the sink.', ['Sink: "small leak under the sink"'])).toBe(true);
    expect(conditionWordsSupported('There may be asbestos in the eaves.', ['Roof and gutters'])).toBe(false);
  });
});

describe('notes are the owner’s only (decision 6)', () => {
  const untouchable = new Proxy({}, { get: () => { throw new Error('the database was touched'); } }) as unknown as DbOrTx;
  const nobody = { userId: '' };

  it('refuses a visitor who is not signed in before reading anything', async () => {
    for (const run of [() => loadNotebook(untouchable, nobody, 'a'), () => saveNotebook(untouchable, nobody, 'a', { notes: 'x' }), () => deleteAllNotebooks(untouchable, nobody)]) {
      await expect(run()).rejects.toBeInstanceOf(NotebookError);
    }
  });

  it('refuses to record a photo stored under someone else’s prefix', async () => {
    await expect(recordPhoto(untouchable, { userId: 'buyer-1' }, { noteId: 'n1', key: 'u/buyer-2/n1/x.jpg', contentType: 'image/jpeg', bytes: 10 })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
