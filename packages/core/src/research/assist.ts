import type { DbOrTx } from '@repo/db';
import { checkDraft, type AssistRecord, type CheckedLine, type DraftLine } from '../due-diligence/assist';
import { dueDiligenceRecords } from '../due-diligence/records';
import { suburbProfile, type SuburbProfile } from './suburb';
import { comparables, homeRows, MAX_COMPARE, MIN_COMPARE, type BuyerType, type Comparable, type HomeRow } from './homes';

/**
 * The AI paragraph for Suburb AI, Comparison AI and Property Analyst (ADR 0080, C5). Core builds the records — every
 * one a line of SQL or census fact with a reference — and checks what comes back: a line must cite a record, every
 * figure in it must be in what it cites (C2's check), and it must not pass a verdict (decision 1). The model (#3)
 * only writes sentences. Nothing is saved; the route caches.
 */

export const RESEARCH_FEATURE = 'consumer:research';
export const MAX_RESEARCH_LINES = 5;

export type ResearchKind = 'suburb' | 'compare' | 'explain';
export type ResearchAsk = { kind: 'suburb'; state: string; suburb: string } | { kind: 'compare'; listingIds: string[]; buyer: BuyerType } | { kind: 'explain'; listingId: string };
export type ResearchWriter = (input: { kind: ResearchKind; subject: string; records: AssistRecord[] }) => Promise<{ lines: DraftLine[] }>;

export class ResearchError extends Error {
  constructor(
    public readonly code: 'invalid' | 'not_found' | 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ResearchError';
  }
}

/**
 * A verdict, a value or a prediction (decision 1): any of these drops the line, whatever it cites. Deliberately broad —
 * a lost sentence costs little; a published "good investment" costs a great deal.
 */
const VERDICT = /\b(worth|value|valued|valuation|bargain|cheap|expensive|overpriced|under-?priced|undervalued|overvalued|good (buy|investment|deal)|great (buy|investment|deal)|best|better|worse|should (buy|consider buying|offer)|recommend|will (grow|rise|increase|fall|drop)|growth|capital gain|appreciat\w*|prediction|forecast|likely to (sell|rise|fall))\b/i;

export function passesVerdictRule(text: string): boolean {
  return !VERDICT.test(text);
}

/** C2's check, then the verdict rule. Pure. */
export function checkResearch(lines: readonly DraftLine[], records: readonly AssistRecord[]): CheckedLine[] {
  return checkDraft(lines.filter((l) => passesVerdictRule(l.text)), records, { max: MAX_RESEARCH_LINES, needFact: false });
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const pct = (v: number | null, what: string) => (v === null ? null : `${v}% ${what}`);

/** The suburb as records: S… this site's listings, C… the census. Pure. */
export function suburbRecords(p: SuburbProfile): AssistRecord[] {
  const out: AssistRecord[] = [
    { ref: 'S1', text: `On this site now: ${p.forSale} for sale and ${p.forRent} for rent in ${p.suburb}.` },
    { ref: 'S2', text: p.medianSold ? `Median sold price on this site in the last 12 months: ${AUD.format(p.medianSold.value)}, from ${p.medianSold.sales} sales.` : `Sales on this site in the last 12 months: ${p.salesInWindow} — too few for a median.` },
  ];
  if (p.medianDays) out.push({ ref: 'S3', text: `Median days on the market for those sales: ${p.medianDays.value} days, from ${p.medianDays.sales} sales.` });
  if (p.census) {
    const c = p.census;
    const homes = [pct(c.separateHousePct, 'separate houses'), pct(c.semiDetachedPct, 'semi-detached, terrace or townhouses'), pct(c.flatPct, 'flats or apartments')].filter(Boolean).join(', ');
    const tenure = [pct(c.ownedOutrightPct, 'owned outright'), pct(c.ownedMortgagePct, 'owned with a mortgage'), pct(c.rentedPct, 'rented')].filter(Boolean).join(', ');
    if (c.population !== null) out.push({ ref: 'C1', text: `ABS Census 2021: ${c.population.toLocaleString('en-AU')} people${c.dwellings !== null ? ` in ${c.dwellings.toLocaleString('en-AU')} occupied homes` : ''}.` });
    if (homes) out.push({ ref: 'C2', text: `ABS Census 2021 homes: ${homes}.` });
    if (tenure) out.push({ ref: 'C3', text: `ABS Census 2021 tenure: ${tenure}.` });
    const money = [c.medianRentWeekly !== null ? `median weekly rent ${AUD.format(c.medianRentWeekly)}` : null, c.medianMortgageMonthly !== null ? `median monthly mortgage repayment ${AUD.format(c.medianMortgageMonthly)}` : null].filter(Boolean).join(', ');
    if (money) out.push({ ref: 'C4', text: `ABS Census 2021: ${money}.` });
  }
  return out;
}

const LETTERS = ['A', 'B', 'C', 'D'];

/** Each home as one record, its column letter its reference. Pure. */
export function compareRecords(rows: readonly HomeRow[]): AssistRecord[] {
  return rows.map((r, i) => ({
    ref: LETTERS[i]!,
    text: [
      `${r.address} ${r.state}: ${r.price}`,
      [r.bedrooms !== null ? `${r.bedrooms} bed` : null, r.bathrooms !== null ? `${r.bathrooms} bath` : null, r.carSpaces !== null ? `${r.carSpaces} car` : null].filter(Boolean).join(', ') || null,
      r.landAreaSqm !== null ? `land ${r.landAreaSqm} m²` : null,
      r.daysOnMarket !== null ? `${r.daysOnMarket} days on the market` : null,
      r.priceChanges.length ? `price changes: ${r.priceChanges.join('; ')}` : 'no price changes recorded',
      r.lastSale ? `last sale here: ${r.lastSale}` : null,
      r.stampDuty?.status === 'estimate' ? `stamp duty estimate ${AUD.format(r.stampDuty.duty)}` : null,
    ]
      .filter(Boolean)
      .join('; ') + '.',
  }));
}

/** One home (P), its history (H…), its comparables (K…). Pure. */
export function explainRecords(home: HomeRow, history: readonly { ref: string; when: string; text: string }[], comps: readonly Comparable[]): AssistRecord[] {
  return [
    compareRecords([home]).map((r) => ({ ...r, ref: 'P' }))[0]!,
    ...history.map((h, i) => ({ ref: `H${i + 1}`, text: `${h.when}: ${h.text}` })),
    ...comps.map((c, i) => ({ ref: `K${i + 1}`, text: `Comparable: ${c.address}, ${c.bedrooms ?? '?'} bed${c.landAreaSqm !== null ? `, ${c.landAreaSqm} m²` : ''} — ${c.price}.` })),
  ];
}

/** Everything a research page or tool shows, without the model. */
export async function researchData(db: DbOrTx, ask: ResearchAsk): Promise<{ subject: string; records: AssistRecord[] } | null> {
  if (ask.kind === 'suburb') {
    const p = await suburbProfile(db, ask);
    return p ? { subject: `${p.suburb} ${p.state}`, records: suburbRecords(p) } : null;
  }
  if (ask.kind === 'compare') {
    if (ask.listingIds.length < MIN_COMPARE || ask.listingIds.length > MAX_COMPARE) throw new ResearchError('invalid', `Compare ${MIN_COMPARE} to ${MAX_COMPARE} homes.`);
    const rows = await homeRows(db, ask.listingIds, ask.buyer);
    if (rows.length < MIN_COMPARE) return null;
    return { subject: rows.map((r) => r.address).join(' vs '), records: compareRecords(rows) };
  }
  const [home] = await homeRows(db, [ask.listingId], 'home');
  if (!home) return null;
  const [history, comps] = await Promise.all([dueDiligenceRecords(db as never, home.propertyId, home.listingId), comparables(db, home)]);
  return { subject: home.address, records: explainRecords(home, history.filter((h) => h.when !== 'Now'), comps) };
}

export async function runResearch(db: DbOrTx, writer: ResearchWriter | null, ask: ResearchAsk): Promise<{ lines: CheckedLine[] }> {
  if (!writer) throw new ResearchError('unavailable', 'The AI is not available right now. Every figure is on the page.');
  const data = await researchData(db, ask);
  if (!data) throw new ResearchError('not_found', 'That is not available.');
  let draft: Awaited<ReturnType<ResearchWriter>>;
  try {
    draft = await writer({ kind: ask.kind, subject: data.subject, records: data.records });
  } catch {
    throw new ResearchError('failed', 'The AI could not answer just now. Try again in a moment.');
  }
  return { lines: checkResearch(draft.lines, data.records) };
}
