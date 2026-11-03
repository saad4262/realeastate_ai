import { z } from 'zod';
import {
  AU_DUTY_STATES,
  DUTY_TABLES,
  PHASED_FIRST_HOME,
  QLD_FIRST_HOME_DEDUCTION,
  STATE_DUTY,
  VIC_PPR_LIMIT,
  WA_CONCESSIONAL_LIMIT,
  WA_FIRST_HOME,
  type DutySource,
  type DutyState,
  type DutyTable,
} from './duty-rates';

/**
 * Transfer (stamp) duty for one purchase (ADR 0080, C1 Affordability). Pure arithmetic over the dated
 * tables in duty-rates.ts: the guide is handed the result as a tool result and never works a figure out
 * itself (#4). An estimate, not advice — the page and the guide say so, and link the state's calculator.
 *
 * Out of scope, said on the page: foreign purchaser surcharges, pensioner and off-the-plan concessions,
 * company and trust purchasers, and land that is not residential.
 */

export const dutyInputSchema = z
  .object({
    state: z.enum(AU_DUTY_STATES),
    /** The dutiable value: the price, or the market value if higher. Whole dollars. */
    value: z.number().int().positive().max(100_000_000),
    /** The buyer will live there. */
    ownerOccupier: z.boolean(),
    /** Every buyer is a first home buyer under the state's own rules. Needs `ownerOccupier`. */
    firstHome: z.boolean(),
    propertyKind: z.enum(['established', 'new', 'vacant_land']),
  })
  .strict()
  .refine((v) => !v.firstHome || v.ownerOccupier, { message: 'A first home buyer must live in the home', path: ['ownerOccupier'] });

export type DutyInput = z.infer<typeof dutyInputSchema>;

export type DutyEstimate =
  | {
      status: 'estimate';
      state: DutyState;
      duty: number;
      /** What the general rates alone would charge — the saving is the difference. Null where those rates are not verified. */
      generalDuty: number | null;
      /** Which rates this buyer got. */
      applied: 'general' | 'owner_occupier' | 'first_home';
      /** False inside a phase-in band whose formula the state does not publish: a straight-line estimate. */
      exact: boolean;
      notes: string[];
      sources: DutySource[];
    }
  | { status: 'unverified'; state: DutyState; what: string; sources: DutySource[] };

const cents = (n: number) => Math.round(n * 100) / 100;

/** Duty from one table. Exported for the tests. */
export function dutyFromTable(table: DutyTable, value: number): number {
  let bracket = table.brackets[0]!;
  for (const b of table.brackets) if (value > b.over) bracket = b;
  const above = bracket.wholeValue ? value : value - bracket.over;
  const units = table.partOf100 ? Math.ceil(above / 100) : above / 100;
  return cents(Math.max(bracket.base + units * bracket.ratePer100, table.minimum ?? 0));
}

/** A straight line from nothing at `free` to the full duty at `upTo` — the shape of NSW's and VIC's phase-ins. */
function phaseIn(general: number, value: number, band: { free: number; upTo: number }): number {
  return cents((general * (value - band.free)) / (band.upTo - band.free));
}

export function estimateStampDuty(input: DutyInput): DutyEstimate {
  const { state, value, ownerOccupier, firstHome, propertyKind } = dutyInputSchema.parse(input);
  const rules = STATE_DUTY[state];
  const sources = [rules.source, ...(rules.concessionSources ?? [])];
  const unverified = (what: string): DutyEstimate => ({ status: 'unverified', state, what, sources });
  if (!rules.general) {
    // ACT: the first home buyer's answer is verified even though the general rates are not.
    if (state === 'ACT' && firstHome) {
      return { status: 'estimate', state, duty: 0, generalDuty: null, applied: 'first_home', exact: true, sources, notes: ['From 1 July 2026 an eligible home buyer pays no conveyance duty, with no price or income limit. You must not have owned property in the last five years, and must live there for at least a year.'] };
    }
    return unverified(rules.unverified ?? 'this state’s duty rates');
  }

  const general = dutyFromTable(rules.general, value);
  const result = (duty: number, applied: 'general' | 'owner_occupier' | 'first_home', notes: string[] = [], exact = true): DutyEstimate => ({
    status: 'estimate',
    state,
    duty: cents(duty),
    generalDuty: general,
    applied,
    exact,
    notes,
    sources,
  });
  const home = propertyKind !== 'vacant_land';

  switch (state) {
    case 'NSW': {
      if (!firstHome) return result(general, 'general');
      const band = home ? PHASED_FIRST_HOME.NSW.home : PHASED_FIRST_HOME.NSW.vacantLand;
      const live = ['You must move in within 12 months of settlement and live there for 12 continuous months.'];
      if (value <= band.free) return result(0, 'first_home', live);
      if (value < band.upTo) return result(phaseIn(general, value, band), 'first_home', [...live, `Between $${band.free.toLocaleString('en-AU')} and $${band.upTo.toLocaleString('en-AU')} the concession phases out. This is a straight-line estimate; Revenue NSW’s calculator gives the exact figure.`], false);
      return result(general, 'general', [`Above $${band.upTo.toLocaleString('en-AU')} there is no first home concession.`]);
    }
    case 'VIC': {
      if (firstHome) {
        const band = PHASED_FIRST_HOME.VIC.home;
        const live = ['At least one buyer must live there for 12 continuous months, starting within 12 months of settlement.'];
        if (value <= band.free) return result(0, 'first_home', live);
        if (value <= band.upTo) return result(phaseIn(general, value, band), 'first_home', [...live, 'Between $600,000 and $750,000 the concession phases out. This is a straight-line estimate; the SRO calculator gives the exact figure.'], false);
      }
      if (ownerOccupier && home && value <= VIC_PPR_LIMIT) return result(dutyFromTable(DUTY_TABLES.VIC_PPR, value), 'owner_occupier', ['The principal place of residence concession: homes up to $550,000 you will live in.']);
      return result(general, 'general');
    }
    case 'QLD': {
      if (firstHome && propertyKind === 'new') return result(0, 'first_home', ['A first home buyer of a new home pays no transfer duty on the residential land, with no price cap (from 1 May 2025). Any extra non-residential land is charged at the general rates.']);
      if (firstHome && propertyKind === 'vacant_land') return unverified('Queensland’s first home vacant land concession');
      if (!ownerOccupier || !home) return result(general, 'general');
      const homeDuty = dutyFromTable(DUTY_TABLES.QLD_HOME, value);
      if (!firstHome) return result(homeDuty, 'owner_occupier', ['The home concession rate: a home you will live in.']);
      const deduct = QLD_FIRST_HOME_DEDUCTION.find((d) => value < d.below)?.deduct ?? 0;
      return result(Math.max(0, homeDuty - deduct), 'first_home', [deduct ? `The first home concession takes $${deduct.toLocaleString('en-AU')} off the home concession duty.` : 'At $800,000 or more there is no first home concession; the home concession rate still applies.']);
    }
    case 'WA': {
      if (firstHome) {
        const band = home ? WA_FIRST_HOME.home : WA_FIRST_HOME.vacantLand;
        if (value <= band.free) return result(0, 'first_home', ['The first home owner rate (from 7 May 2026). Needs pre-approval as a first home owner.']);
        if (value <= band.upTo) return result(Math.ceil((value - band.free) / 100) * band.ratePer100, 'first_home', ['The first home owner rate (from 7 May 2026). Needs pre-approval as a first home owner.']);
        return result(general, 'general', ['Above the first home owner rate’s limit the general rate applies.']);
      }
      if (ownerOccupier && home && value <= WA_CONCESSIONAL_LIMIT) return result(dutyFromTable(DUTY_TABLES.WA_CONCESSIONAL, value), 'owner_occupier', ['The concessional rate: a home you will live in, worth $200,000 or less.']);
      return result(general, 'general');
    }
    case 'SA':
      if (firstHome && propertyKind !== 'established') return unverified(rules.unverified!);
      return result(general, 'general', firstHome ? ['South Australia has no first home concession on established homes.'] : []);
    case 'TAS':
      return result(general, 'general', firstHome ? ['Tasmania’s first home exemption for established homes ended for settlements after 30 June 2026.'] : []);
    case 'ACT':
    case 'NT':
      return unverified(rules.unverified!);
  }
}
