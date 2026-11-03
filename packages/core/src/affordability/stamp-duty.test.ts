import { describe, expect, it } from 'vitest';
import { AU_DUTY_STATES, DUTY_TABLES, dutyRatesDue, STATE_DUTY } from './duty-rates';
import { dutyFromTable, estimateStampDuty, type DutyInput } from './stamp-duty';

/** Every figure below is worked by hand from the state's published table (see duty-rates.ts for each source). */
const buy = (over: Partial<DutyInput> & Pick<DutyInput, 'state' | 'value'>): DutyInput => ({ ownerOccupier: false, firstHome: false, propertyKind: 'established', ...over });
const duty = (input: DutyInput) => {
  const r = estimateStampDuty(input);
  if (r.status !== 'estimate') throw new Error(`not an estimate: ${r.what}`);
  return r;
};

describe('the rate tables', () => {
  it('every state names its source and the day it was checked', () => {
    for (const s of AU_DUTY_STATES) {
      expect(STATE_DUTY[s].source.url).toMatch(/^https:\/\//);
      expect(STATE_DUTY[s].source.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (!STATE_DUTY[s].general) expect(STATE_DUTY[s].unverified).toBeTruthy();
    }
  });

  it('every table climbs: brackets in order, and more value never costs less duty', () => {
    for (const table of Object.values(DUTY_TABLES)) {
      const overs = table.brackets.map((b) => b.over);
      expect(overs).toEqual([...overs].sort((a, b) => a - b));
      let last = 0;
      for (let v = 1_000; v <= 5_000_000; v += 7_919) {
        const d = dutyFromTable(table, v);
        expect(d).toBeGreaterThanOrEqual(last);
        last = d;
      }
    }
  });
});

describe('general rates', () => {
  it.each([
    ['NSW', 1_000_000, 39_187],
    ['NSW', 387_050, 11_606.5], // "or part of $100": $50 over is one whole $100
    ['NSW', 1_000, 20], // the minimum
    ['NSW', 4_000_000, 203_237], // premium property
    ['VIC', 800_000, 43_070],
    ['VIC', 960_000, 52_670],
    ['VIC', 1_000_000, 55_000], // 5.5% of the whole value
    ['VIC', 2_500_000, 142_500],
    ['QLD', 5_000, 0],
    ['QLD', 800_000, 29_025],
    ['WA', 600_000, 22_515],
    ['SA', 300_000, 11_330],
    ['SA', 600_000, 26_830],
    ['TAS', 2_000, 50],
    ['TAS', 500_000, 18_247.5],
  ] as const)('%s at $%i is $%d', (state, value, expected) => {
    const r = duty(buy({ state, value }));
    expect(r.duty).toBe(expected);
    expect(r.applied).toBe('general');
  });
});

describe('a home the buyer will live in', () => {
  it('VIC: the PPR rates up to $550,000, the general rates above', () => {
    expect(duty(buy({ state: 'VIC', value: 500_000, ownerOccupier: true }))).toMatchObject({ duty: 21_970, applied: 'owner_occupier', generalDuty: 25_070 });
    expect(duty(buy({ state: 'VIC', value: 600_000, ownerOccupier: true })).applied).toBe('general');
  });

  it('QLD: the home concession rate', () => {
    expect(duty(buy({ state: 'QLD', value: 800_000, ownerOccupier: true }))).toMatchObject({ duty: 21_850, applied: 'owner_occupier' });
  });

  it('WA: the concessional rate only to $200,000', () => {
    expect(duty(buy({ state: 'WA', value: 150_000, ownerOccupier: true }))).toMatchObject({ duty: 3_012, applied: 'owner_occupier' });
    expect(duty(buy({ state: 'WA', value: 250_000, ownerOccupier: true })).applied).toBe('general');
  });
});

describe('first home buyers', () => {
  const first = (state: DutyInput['state'], value: number, propertyKind: DutyInput['propertyKind'] = 'established') => buy({ state, value, propertyKind, ownerOccupier: true, firstHome: true });

  it('NSW: nothing to $800,000, a phase-out (marked approximate) to $1m, then the general rates', () => {
    expect(duty(first('NSW', 800_000))).toMatchObject({ duty: 0, exact: true });
    expect(duty(first('NSW', 900_000))).toMatchObject({ duty: 17_343.5, exact: false, generalDuty: 34_687 });
    expect(duty(first('NSW', 1_000_000))).toMatchObject({ duty: 39_187, applied: 'general' });
    expect(duty(first('NSW', 350_000, 'vacant_land')).duty).toBe(0);
  });

  it('VIC: nothing to $600,000, a phase-out (approximate) to $750,000', () => {
    expect(duty(first('VIC', 550_000)).duty).toBe(0);
    expect(duty(first('VIC', 700_000))).toMatchObject({ duty: 24_713.33, exact: false });
    expect(duty(first('VIC', 800_000))).toMatchObject({ duty: 43_070, applied: 'general' });
  });

  it('QLD: established homes take the deduction; new homes pay nothing at any price; vacant land is not verified', () => {
    expect(duty(first('QLD', 700_000)).duty).toBe(0);
    expect(duty(first('QLD', 750_000)).duty).toBe(10_925);
    expect(duty(first('QLD', 2_000_000, 'new')).duty).toBe(0);
    expect(estimateStampDuty(first('QLD', 400_000, 'vacant_land')).status).toBe('unverified');
  });

  it('WA: the first home owner rate from 7 May 2026', () => {
    expect(duty(first('WA', 600_000)).duty).toBe(0);
    expect(duty(first('WA', 700_000)).duty).toBe(16_150);
    expect(duty(first('WA', 500_000, 'vacant_land')).duty).toBe(10_070);
    expect(duty(first('WA', 900_000)).applied).toBe('general');
  });

  it('TAS: no exemption since 30 June 2026, and the buyer is told so', () => {
    const r = duty(first('TAS', 500_000));
    expect(r.duty).toBe(18_247.5);
    expect(r.notes.join()).toMatch(/ended/);
  });

  it('ACT: nothing for an eligible home buyer from 1 July 2026; the general rates are not verified, so no figure', () => {
    expect(duty(first('ACT', 1_500_000))).toMatchObject({ duty: 0, generalDuty: null });
    expect(estimateStampDuty(buy({ state: 'ACT', value: 800_000 })).status).toBe('unverified');
  });

  it('SA new homes and the NT: no figure until verified, and the official source to check', () => {
    for (const r of [estimateStampDuty(first('SA', 600_000, 'new')), estimateStampDuty(buy({ state: 'NT', value: 500_000 }))]) {
      expect(r.status).toBe('unverified');
      expect(r.sources[0]!.url).toMatch(/^https:\/\//);
    }
  });

  it('refuses a first home buyer who will not live there', () => {
    expect(() => estimateStampDuty(buy({ state: 'NSW', value: 500_000, firstHome: true }))).toThrow(/live in the home/);
  });
});

describe('what needs a person (the 1 July re-check)', () => {
  it('nothing is stale until the next 1 July; every source is due after it', () => {
    expect(dutyRatesDue(new Date('2027-06-30T00:00:00Z')).stale).toEqual([]);
    const due = dutyRatesDue(new Date('2027-07-02T00:00:00Z'));
    expect(due.lastFirstOfJuly).toBe('2027-07-01');
    expect(due.stale.map((s) => s.state)).toContain('NSW');
  });

  it('lists what is still unverified: NT, the ACT, SA new homes, QLD first home land', () => {
    expect(dutyRatesDue(new Date('2026-11-03T00:00:00Z')).unverified.map((u) => u.state).sort()).toEqual(['ACT', 'NT', 'QLD', 'SA']);
  });
});
