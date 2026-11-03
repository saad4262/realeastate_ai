/**
 * Transfer (stamp) duty rate tables per state (ADR 0080, docs/CONSUMER-SKILLS.md C1). Every table carries
 * where it came from and the day it was checked. A table nobody could check against the state's own
 * revenue office is not here: its state answers "not verified" and links to the official calculator —
 * the skill never fills a gap with a number from memory (non-negotiable #4; the user, 2026-11-03).
 *
 * Checked 2026-11-03. Re-check every 1 July (NSW indexes its brackets yearly; ACT, WA, TAS and QLD
 * changed their first-home rules in 2025–26) and whenever a state budget says so.
 */

export const AU_DUTY_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const;
export type DutyState = (typeof AU_DUTY_STATES)[number];

export type DutySource = { name: string; url: string; checkedOn: string };

/**
 * One bracket: from `over` (exclusive) up to the next bracket's `over`. Duty = `base` + `ratePer100` for
 * every $100 above `over` — or, with `wholeValue`, for every $100 of the whole value (VIC's $960k–$2m band).
 */
export type DutyBracket = { over: number; base: number; ratePer100: number; wholeValue?: true };

export type DutyTable = {
  brackets: readonly DutyBracket[];
  /** "for each $100 or part of $100": the amount above the threshold is rounded UP to the next $100. */
  partOf100: boolean;
  /** The least duty payable, when the state sets one. */
  minimum?: number;
};

const NSW_SOURCE: DutySource = { name: 'Revenue NSW — current thresholds and rates (2026/2027)', url: 'https://www.revenue.nsw.gov.au/_resources/duties-links/current-thresholds-and-rates', checkedOn: '2026-11-03' };
const NSW_FHB_SOURCE: DutySource = { name: 'Revenue NSW — First Home Buyers Assistance scheme', url: 'https://www.revenue.nsw.gov.au/grants-schemes/first-home-buyer/assistance-scheme', checkedOn: '2026-11-03' };
const VIC_SOURCE: DutySource = { name: 'SRO Victoria — general land transfer duty current rates', url: 'https://www.sro.vic.gov.au/rates-taxes-duties-and-levies/general-land-transfer-duty-property-current-rates', checkedOn: '2026-11-03' };
const VIC_PPR_SOURCE: DutySource = { name: 'SRO Victoria — principal place of residence current rates', url: 'https://www.sro.vic.gov.au/principal-place-residence-current-rates', checkedOn: '2026-11-03' };
const VIC_FHB_SOURCE: DutySource = { name: 'SRO Victoria — first home buyer duty exemption or concession', url: 'https://www.sro.vic.gov.au/land-transfer-duty/first-home-buyer-duty-exemption-or-concession', checkedOn: '2026-11-03' };
const QLD_SOURCE: DutySource = { name: 'Queensland Revenue Office — transfer duty rates', url: 'https://qro.qld.gov.au/duties/transfer-duty/calculate/rates/', checkedOn: '2026-11-03' };
const QLD_HOME_SOURCE: DutySource = { name: 'Queensland Revenue Office — home concession rates', url: 'https://qro.qld.gov.au/duties/transfer-duty/calculate/concession-rates/', checkedOn: '2026-11-03' };
const WA_SOURCE: DutySource = { name: 'WA Department of Treasury and Finance — transfer duty assessment', url: 'https://www.wa.gov.au/organisation/department-of-treasury-and-finance/transfer-duty-assessment', checkedOn: '2026-11-03' };
const SA_SOURCE: DutySource = { name: 'RevenueSA — rate of stamp duty', url: 'https://www.revenuesa.sa.gov.au/stamp-duty-land/rate-of-stamp-duty', checkedOn: '2026-11-03' };
const TAS_SOURCE: DutySource = { name: 'SRO Tasmania — rates of duty', url: 'https://www.sro.tas.gov.au/property-transfer-duties/rates-of-duty', checkedOn: '2026-11-03' };
const ACT_SOURCE: DutySource = { name: 'ACT Revenue Office — conveyance duty and the Home Buyer Concession Scheme', url: 'https://www.revenue.act.gov.au/home-buyer-assistance/home-buyer-concession-scheme/about-the-home-buyer-concession-scheme', checkedOn: '2026-11-03' };
const NT_SOURCE: DutySource = { name: 'NT Territory Revenue Office — stamp duty', url: 'https://treasury.nt.gov.au/dtf/territory-revenue-office/stamp-duty', checkedOn: '2026-11-03' };

/** NSW 2026/27, by contract date. Residential property over the premium threshold pays the premium rate. */
const NSW_GENERAL: DutyTable = {
  partOf100: true,
  minimum: 20,
  brackets: [
    { over: 0, base: 0, ratePer100: 1.25 },
    { over: 18_000, base: 225, ratePer100: 1.5 },
    { over: 38_000, base: 525, ratePer100: 1.75 },
    { over: 103_000, base: 1_662, ratePer100: 3.5 },
    { over: 387_000, base: 11_602, ratePer100: 4.5 },
    { over: 1_290_000, base: 52_237, ratePer100: 5.5 },
    { over: 3_870_000, base: 194_137, ratePer100: 7 },
  ],
};

/** VIC general (non-PPR), contracts on or after 1 July 2021. Percentages, so no rounding to $100. */
const VIC_GENERAL: DutyTable = {
  partOf100: false,
  brackets: [
    { over: 0, base: 0, ratePer100: 1.4 },
    { over: 25_000, base: 350, ratePer100: 2.4 },
    { over: 130_000, base: 2_870, ratePer100: 6 },
    { over: 960_000, base: 0, ratePer100: 5.5, wholeValue: true },
    { over: 2_000_000, base: 110_000, ratePer100: 6.5 },
  ],
};

/** VIC principal place of residence concession: only up to $550,000; above it the general rates apply. */
const VIC_PPR: DutyTable = {
  partOf100: false,
  brackets: [
    { over: 0, base: 0, ratePer100: 1.4 },
    { over: 25_000, base: 350, ratePer100: 2.4 },
    { over: 130_000, base: 2_870, ratePer100: 5 },
    { over: 440_000, base: 18_370, ratePer100: 6 },
  ],
};
export const VIC_PPR_LIMIT = 550_000;

const QLD_GENERAL: DutyTable = {
  partOf100: true,
  brackets: [
    { over: 0, base: 0, ratePer100: 0 },
    { over: 5_000, base: 0, ratePer100: 1.5 },
    { over: 75_000, base: 1_050, ratePer100: 3.5 },
    { over: 540_000, base: 17_325, ratePer100: 4.5 },
    { over: 1_000_000, base: 38_025, ratePer100: 5.75 },
  ],
};

/** QLD home concession rate: the buyer will live there. */
const QLD_HOME: DutyTable = {
  partOf100: true,
  brackets: [
    { over: 0, base: 0, ratePer100: 1 },
    { over: 350_000, base: 3_500, ratePer100: 3.5 },
    { over: 540_000, base: 10_150, ratePer100: 4.5 },
    { over: 1_000_000, base: 30_850, ratePer100: 5.75 },
  ],
};

/** QLD first home concession (not a new home), contracts on or after 9 June 2024: deducted from the home concession duty. */
export const QLD_FIRST_HOME_DEDUCTION: readonly { below: number; deduct: number }[] = [
  { below: 710_000, deduct: 17_350 },
  { below: 720_000, deduct: 15_615 },
  { below: 730_000, deduct: 13_880 },
  { below: 740_000, deduct: 12_145 },
  { below: 750_000, deduct: 10_410 },
  { below: 760_000, deduct: 8_675 },
  { below: 770_000, deduct: 6_940 },
  { below: 780_000, deduct: 5_205 },
  { below: 790_000, deduct: 3_470 },
  { below: 800_000, deduct: 1_735 },
];

const WA_GENERAL: DutyTable = {
  partOf100: true,
  brackets: [
    { over: 0, base: 0, ratePer100: 1.9 },
    { over: 120_000, base: 2_280, ratePer100: 2.85 },
    { over: 150_000, base: 3_135, ratePer100: 3.8 },
    { over: 360_000, base: 11_115, ratePer100: 4.75 },
    { over: 725_000, base: 28_453, ratePer100: 5.15 },
  ],
};

/** WA concessional rate: a principal place of residence whose whole value is at most $200,000. */
const WA_CONCESSIONAL: DutyTable = {
  partOf100: true,
  brackets: [
    { over: 0, base: 0, ratePer100: 1.5 },
    { over: 120_000, base: 1_800, ratePer100: 4.04 },
  ],
};
export const WA_CONCESSIONAL_LIMIT = 200_000;

/** WA first home owner rate from 7 May 2026 (no metro/regional split since then). */
export const WA_FIRST_HOME = {
  home: { free: 600_000, upTo: 800_000, ratePer100: 16.15 },
  vacantLand: { free: 450_000, upTo: 550_000, ratePer100: 20.14 },
} as const;

const SA_GENERAL: DutyTable = {
  partOf100: true,
  brackets: [
    { over: 0, base: 0, ratePer100: 1 },
    { over: 12_000, base: 120, ratePer100: 2 },
    { over: 30_000, base: 480, ratePer100: 3 },
    { over: 50_000, base: 1_080, ratePer100: 3.5 },
    { over: 100_000, base: 2_830, ratePer100: 4 },
    { over: 200_000, base: 6_830, ratePer100: 4.25 },
    { over: 250_000, base: 8_955, ratePer100: 4.75 },
    { over: 300_000, base: 11_330, ratePer100: 5 },
    { over: 500_000, base: 21_330, ratePer100: 5.5 },
  ],
};

/** TAS, transfers from 21 October 2013. The first-home exemption for established homes ended 30 June 2026. */
const TAS_GENERAL: DutyTable = {
  partOf100: true,
  minimum: 50,
  brackets: [
    { over: 0, base: 50, ratePer100: 0 },
    { over: 3_000, base: 50, ratePer100: 1.75 },
    { over: 25_000, base: 435, ratePer100: 2.25 },
    { over: 75_000, base: 1_560, ratePer100: 3.5 },
    { over: 200_000, base: 5_935, ratePer100: 4 },
    { over: 375_000, base: 12_935, ratePer100: 4.25 },
    { over: 725_000, base: 27_810, ratePer100: 4.5 },
  ],
};

/** The first-home thresholds where a state phases its concession in, but publishes no formula for the band. */
export const PHASED_FIRST_HOME = {
  NSW: { home: { free: 800_000, upTo: 1_000_000 }, vacantLand: { free: 350_000, upTo: 450_000 } },
  VIC: { home: { free: 600_000, upTo: 750_000 } },
} as const;

export type StateDutyRules = {
  general: DutyTable | null;
  source: DutySource;
  /** Extra sources for concessions, shown with the answer. */
  concessionSources?: readonly DutySource[];
  /** Why a buyer of this state gets "not verified" for the parts we could not check. */
  unverified?: string;
};

export const STATE_DUTY: Readonly<Record<DutyState, StateDutyRules>> = Object.freeze({
  NSW: { general: NSW_GENERAL, source: NSW_SOURCE, concessionSources: [NSW_FHB_SOURCE] },
  VIC: { general: VIC_GENERAL, source: VIC_SOURCE, concessionSources: [VIC_PPR_SOURCE, VIC_FHB_SOURCE] },
  QLD: { general: QLD_GENERAL, source: QLD_SOURCE, concessionSources: [QLD_HOME_SOURCE] },
  WA: { general: WA_GENERAL, source: WA_SOURCE },
  SA: { general: SA_GENERAL, source: SA_SOURCE, unverified: 'RevenueSA’s relief for first home buyers of new homes and vacant land' },
  TAS: { general: TAS_GENERAL, source: TAS_SOURCE },
  ACT: { general: null, source: ACT_SOURCE, unverified: 'the ACT’s 2026–27 conveyance duty rates' },
  NT: { general: null, source: NT_SOURCE, unverified: 'the Northern Territory’s current stamp duty rates and the Territory Home Owner Discount' },
});

export const DUTY_TABLES = { NSW_GENERAL, VIC_GENERAL, VIC_PPR, QLD_GENERAL, QLD_HOME, WA_GENERAL, WA_CONCESSIONAL, SA_GENERAL, TAS_GENERAL } as const;

/**
 * What needs a person (ROADMAP technical debt: "Stamp duty rates go stale"). States set new rates and
 * concessions from 1 July, so every source checked before the latest 1 July is due again; and every state
 * with something unverified is listed until it is not. Pure — `now` is passed in — so a unit test pins it and
 * `pnpm smoke` reports it as a note on every run, without turning `pnpm test` red on a date.
 */
export function dutyRatesDue(now: Date): { lastFirstOfJuly: string; stale: { state: DutyState; source: DutySource }[]; unverified: { state: DutyState; what: string }[] } {
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const lastFirstOfJuly = `${year}-07-01`;
  const stale: { state: DutyState; source: DutySource }[] = [];
  const unverified: { state: DutyState; what: string }[] = [];
  for (const state of AU_DUTY_STATES) {
    const rules = STATE_DUTY[state];
    for (const source of [rules.source, ...(rules.concessionSources ?? [])]) if (source.checkedOn < lastFirstOfJuly) stale.push({ state, source });
    if (rules.unverified) unverified.push({ state, what: rules.unverified });
  }
  // Queensland's first home vacant land concession is refused in stamp-duty.ts, not in the table.
  unverified.push({ state: 'QLD', what: 'Queensland’s first home vacant land concession' });
  return { lastFirstOfJuly, stale, unverified };
}
