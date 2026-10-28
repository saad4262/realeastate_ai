import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { holderOf, isSkillOn } from '../skill-switches/switches';
import { skillOffMessage } from '../skill-switches/catalog';
import { unsupportedFigures } from '../mail/reply-assist';
import { DEAL_STAGE_LABELS } from '../deals/stages';
import { audWhole, getPropertyView, listingStatusWords, type PropertyView } from './property-page';

/**
 * A property's summary (ADR 0065 §5): on a button, never saved. Core turns what this person may see on the
 * page into numbered records; the model (packages/ai, behind `PropertySummarizer`, #3) writes points that
 * cite them; core keeps a point only when every record it cites exists and every figure it states is in
 * those records (#4). The same checks as the inbox's summary, over a property's records.
 */

export const PROPERTY_SUMMARY_FEATURE = 'property:summary';
export const MAX_SUMMARY_POINTS = 6;
const MAX_RECORDS = 60;
const RECORD_CHARS = 400;

/** Which tab a record lives on, so a citation can open it. */
export type RecordTab = 'overview' | 'people' | 'enquiries' | 'visits' | 'documents' | 'history';
export type PropertyRecord = { ref: string; tab: RecordTab; label: string; text: string };
export type PropertySummaryPoint = { text: string; refs: string[] };
export type CheckedPoint = { text: string; cites: { ref: string; label: string; tab: RecordTab }[] };
export type PropertySummarizer = (input: { records: PropertyRecord[]; agencyId: string; userId: string }) => Promise<{ points: PropertySummaryPoint[] }>;

export class PropertySummaryError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'unavailable' | 'budget' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'PropertySummaryError';
  }
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const short = (d: Date) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, RECORD_CHARS);
const money = (n: number | null) => (n === null ? null : audWhole(n));

function wallClock(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-AU', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** The page as numbered records — only what this person may see, newest first within each kind. Pure. */
export function propertyRecords(v: PropertyView, now: Date): PropertyRecord[] {
  const out: PropertyRecord[] = [];
  const f = v.facts;
  const parts = [
    f.propertyType,
    f.bedrooms !== null ? `${f.bedrooms} bed` : null,
    f.bathrooms !== null ? `${f.bathrooms} bath` : null,
    f.carSpaces !== null ? `${f.carSpaces} car` : null,
    f.landAreaSqm !== null ? `land ${f.landAreaSqm} m²` : null,
    f.yearBuilt !== null ? `built ${f.yearBuilt}` : null,
  ].filter(Boolean);
  out.push({ ref: 'P', tab: 'overview', label: 'Property', text: clip(`The property: ${f.address} ${f.state} ${f.postcode}. ${parts.join(', ') || 'No details recorded.'} Today is ${day(now)}.`) });
  // Counts of the rows loaded for this page, so a point may say "7 enquiries" from a record (#4).
  const n = (k: string) => v.leads.filter((l) => l.kind === k).length;
  const totals = [
    `${n('enquiry')} enquiries`,
    `${n('inspection')} inspection requests`,
    `${n('appraisal')} appraisal requests`,
    ...(v.maySeeOffers ? [`${n('offer')} private offers`] : []),
    `${v.appointments.length} appointments`,
    `${v.inspections.filter((x) => x.startsAt <= now).length} open homes held`,
    `${v.documents.length} documents`,
    `${v.people.length} people`,
  ];
  out.push({ ref: 'T', tab: 'enquiries', label: 'Totals', text: clip(`Totals on record at this address: ${totals.join(', ')}.`) });

  if (v.deal) {
    const d = v.deal;
    const conds = d.conditions.map((c) => `${c.label}${c.dueOn ? ` due ${c.dueOn}` : ''} (${c.done ? 'met' : 'not met'})`).join('; ');
    out.push({
      ref: 'D',
      tab: 'overview',
      label: 'Deal',
      text: clip(
        `Deal: ${d.status === 'open' ? `open, at stage ${DEAL_STAGE_LABELS[d.stage]}` : d.status}. ` +
          [d.salePrice !== null ? `Sale price ${money(d.salePrice)}` : null, d.contractDate ? `contract ${d.contractDate}` : null, d.settlementDate ? `settlement ${d.settlementDate}` : null, d.agentName ? `agent ${d.agentName}` : null]
            .filter(Boolean)
            .join(', ') +
          (conds ? `. Conditions: ${conds}` : ''),
      ),
    });
  }
  v.listings.slice(0, 5).forEach((l, i) => {
    out.push({
      ref: `H${i + 1}`,
      tab: 'history',
      label: l.publishedAt ? `Campaign ${l.publishedAt.getUTCFullYear()}` : 'Campaign',
      text: clip(
        `Our ${l.channel === 'rent' ? 'rental' : 'sale'} listing, status ${listingStatusWords(l.status)}, price ${l.priceText}` +
          (l.publishedAt ? `, live from ${day(l.publishedAt)}` : '') +
          (l.daysOnMarket !== null ? `, ${l.daysOnMarket} days on market` : '') +
          (l.status === 'sold' && l.soldDate ? `, sold ${l.soldDate}${l.soldPrice !== null ? ` for ${money(l.soldPrice)}` : ''}` : '') +
          (l.agentName ? `, agent ${l.agentName}` : '') +
          '.',
      ),
    });
  });
  v.people.slice(0, 12).forEach((p, i) => {
    out.push({ ref: `C${i + 1}`, tab: 'people', label: p.name, text: clip(`Person: ${p.name} — ${p.roles.join(', ')}.`) });
  });
  v.leads.slice(0, 20).forEach((l, i) => {
    const what = l.kind === 'offer' ? `Private offer${l.offerAmount !== null ? ` of ${money(l.offerAmount)}` : ''}` : l.kind === 'enquiry' ? 'Enquiry' : l.kind === 'inspection' ? 'Inspection request' : 'Appraisal request';
    out.push({
      ref: `E${i + 1}`,
      tab: 'enquiries',
      label: `${l.kind === 'offer' ? 'Offer' : 'Enquiry'} ${short(l.createdAt)}`,
      text: clip(`${day(l.createdAt)} ${what} from ${l.name}, status ${l.status}.${l.message ? ` Message: "${l.message}"` : ''}`),
    });
  });
  v.appointments.slice(0, 10).forEach((a, i) => {
    out.push({
      ref: `A${i + 1}`,
      tab: 'visits',
      label: `${a.typeLabel} ${short(a.startsAt)}`,
      text: clip(`${a.typeLabel}${a.contactName ? ` with ${a.contactName}` : ''} on ${wallClock(a.startsAt, a.timezone)} (${a.startsAt > now ? 'booked' : a.status})${a.agentName ? `, agent ${a.agentName}` : ''}.${a.outcome ? ` Outcome: "${a.outcome}"` : ''}`),
    });
  });
  const past = v.inspections.filter((x) => x.startsAt <= now);
  if (past.length) out.push({ ref: 'I', tab: 'visits', label: 'Open homes', text: clip(`${past.length} open home or inspection time${past.length === 1 ? '' : 's'} held, the latest on ${day(past[0]!.startsAt)}.`) });
  v.documents.slice(0, 10).forEach((d, i) => {
    out.push({ ref: `F${i + 1}`, tab: 'documents', label: d.title, text: clip(`Document "${d.title}" (${d.kind}) on the ${d.on}, added ${day(d.createdAt)}${d.uploader ? ` by ${d.uploader}` : ''}.`) });
  });
  return out.slice(0, MAX_RECORDS);
}

/**
 * Keep a point only when it cites at least one record that exists and every figure it states is in the
 * records it cites. At most six. Pure.
 */
export function checkPropertySummary(points: readonly PropertySummaryPoint[], records: readonly PropertyRecord[]): CheckedPoint[] {
  const byRef = new Map(records.map((r) => [r.ref, r]));
  const out: CheckedPoint[] = [];
  for (const p of points) {
    const cited = [...new Set(p.refs)].map((r) => byRef.get(r)).filter((r): r is PropertyRecord => Boolean(r));
    const text = p.text.trim().slice(0, 300);
    if (!text || !cited.length) continue;
    if (unsupportedFigures(text, cited.map((r) => r.text)).length) continue;
    out.push({ text, cites: cited.map((r) => ({ ref: r.ref, label: r.label, tab: r.tab })) });
    if (out.length === MAX_SUMMARY_POINTS) break;
  }
  return out;
}

function capFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Today's spend on property summaries for this agency, and on AI overall, under their caps. */
export async function propertyAiAllowed(db: Db, agencyId: string, env: NodeJS.ProcessEnv, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const [row] = await db.execute<{ agency: string; total: string }>(sql`
    select
      coalesce((select sum(r.cost_usd) from ai_run r where r.agency_id = ${agencyId} and r.feature = ${PROPERTY_SUMMARY_FEATURE} and r.created_at >= ${since}), 0) as agency,
      coalesce((select sum(r.cost_usd) from ai_run r where r.created_at >= ${since}), 0) as total`);
  return Number(row?.total ?? 0) < capFrom(env.AI_DAILY_BUDGET_USD, 5) && Number(row?.agency ?? 0) < capFrom(env.PROPERTY_AI_DAILY_BUDGET_USD_PER_AGENCY, 2);
}

/** "Summarise this property": up to six points, each citing the records it came from. */
export async function summarizeProperty(
  db: Db,
  actor: Actor,
  propertyId: string,
  summarizer: PropertySummarizer | null,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<{ points: CheckedPoint[]; recordCount: number }> {
  if (!summarizer) throw new PropertySummaryError('unavailable', 'The assistant is not set up on this server.');
  const now = opts.now ?? new Date();
  let view: PropertyView | null;
  try {
    view = await getPropertyView(db, actor, propertyId, { now });
  } catch {
    view = null;
  }
  if (!view || !actor.agencyId) throw new PropertySummaryError('forbidden', 'That property was not found.');
  if (!(await isSkillOn(db, actor, 'property_summaries'))) throw new PropertySummaryError('forbidden', skillOffMessage('property_summaries', holderOf(actor.membershipRole)));
  const records = propertyRecords(view, now);
  if (records.length < 2) throw new PropertySummaryError('unavailable', 'There is nothing on this property to summarise yet.');
  if (!(await propertyAiAllowed(db, actor.agencyId, opts.env ?? process.env, now))) {
    throw new PropertySummaryError('budget', 'Today’s AI budget for property summaries is used up. Try again tomorrow.');
  }
  let raw: { points: PropertySummaryPoint[] };
  try {
    raw = await summarizer({ records, agencyId: actor.agencyId, userId: actor.userId });
  } catch (err) {
    console.error('[property] summary failed', err instanceof Error ? err.message : err);
    throw new PropertySummaryError('failed', 'The summary could not be written. Try again.');
  }
  const points = checkPropertySummary(raw.points, records);
  if (!points.length) throw new PropertySummaryError('failed', 'The summary could not be checked against the records, so it is not shown. Try again.');
  return { points, recordCount: records.length };
}
