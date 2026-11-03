import { and, eq, sql } from 'drizzle-orm';
import { listing, property, type Db } from '@repo/db';
import { unsupportedFigures } from '../mail/reply-assist';
import { publicListing } from '../listings/search-listings';
import { HISTORIC_STATUSES } from '../listings/listing-detail';
import { checklistFor, GENERAL_CHECKLIST } from './checklists';
import { dueDiligenceRecords, type RecordFact } from './records';

/**
 * Due-Diligence AI's model half (ADR 0080, C2 decisions 3 and 6): a short summary of the records and questions
 * for the agent. Core decides what the model is given and checks what it gives back; the model (packages/ai,
 * behind `DueDiligenceWriter`, #3) only writes sentences that cite references. A point or question survives
 * only when every reference it cites exists and every figure it states is in those records (#4) — ADR 0065's
 * check. Nothing is saved (decision 3).
 */

export const DUE_DILIGENCE_FEATURE = 'consumer:due_diligence';
export const MAX_SUMMARY_POINTS = 4;
export const MAX_QUESTIONS = 6;

/** What the model is shown: the records (R1…) and the checklist items (K1…), each one line. */
export type AssistRecord = { ref: string; text: string };
export type DraftLine = { text: string; refs: string[] };
export type DueDiligenceWriter = (input: { address: string; records: AssistRecord[]; wantQuestions: boolean }) => Promise<{ summary: DraftLine[]; questions: DraftLine[] }>;
export type CheckedLine = { text: string; refs: string[] };

export class DueDiligenceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'DueDiligenceError';
  }
}

/**
 * The address a request may be about, decided by the server (ARCHITECTURE § 9): a listing the public can see
 * right now, or an address whose public history exists. The browser names an id and nothing else.
 */
export async function publicSubject(db: Db, ask: { listingId: string } | { propertyId: string }): Promise<null | { propertyId: string; listingId: string | null; state: string; address: string }> {
  if ('listingId' in ask) {
    const [row] = await db
      .select({ propertyId: listing.propertyId, state: property.state, address: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street}) || ', ' || ${property.suburb}` })
      .from(listing)
      .innerJoin(property, eq(property.id, listing.propertyId))
      .where(and(eq(listing.id, ask.listingId), publicListing()))
      .limit(1);
    return row ? { propertyId: row.propertyId, listingId: ask.listingId, state: row.state, address: row.address } : null;
  }
  const [row] = await db
    .select({ state: property.state, address: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street}) || ', ' || ${property.suburb}` })
    .from(property)
    // The outer column written out, not interpolated: a single-table select (single-table-subquery.test.ts).
    .where(and(eq(property.id, ask.propertyId), sql`exists (select 1 from listing l where l.property_id = property.id and l.status in ${sql.raw(`(${HISTORIC_STATUSES.map((st) => `'${st}'`).join(',')})`)})`))
    .limit(1);
  return row ? { propertyId: ask.propertyId, listingId: null, state: row.state, address: row.address } : null;
}

/** The records the model is given: the facts, then the checklist for the state. Pure. */
export function assistRecords(facts: readonly RecordFact[], state: string): AssistRecord[] {
  const items = [...(checklistFor(state)?.items ?? []), ...GENERAL_CHECKLIST];
  return [...facts.map((f) => ({ ref: f.ref, text: `${f.when}: ${f.text}` })), ...items.map((it, i) => ({ ref: `K${i + 1}`, text: `Checklist: ${it.title}. ${it.detail}` }))];
}

/**
 * The line as a buyer reads it: references written into the text ("[K2]", "(R1, R3)") taken out — they are shown
 * beside the line from `refs` — and whitespace folded. Found live (2026-11-03): the model wrote "[K2]" inside its
 * questions, and the figure check read that "2" as a number no record holds, dropping five questions of six.
 */
export function cleanLine(s: string): string {
  return s
    .replace(/\s*[[(]\s*[RK]\d+(?:\s*[,;]\s*[RK]\d+)*\s*[\])]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Keep a line only when it cites at least one record that exists, every figure in it is in the records it
 * cites, and it carries no link. A summary point must cite a fact (R…) — the checklist is not news about the
 * property. Pure.
 */
export function checkDraft(lines: readonly DraftLine[], records: readonly AssistRecord[], opts: { max: number; needFact: boolean }): CheckedLine[] {
  const byRef = new Map(records.map((r) => [r.ref, r.text]));
  const out: CheckedLine[] = [];
  for (const line of lines) {
    const refs = [...new Set(line.refs)].filter((r) => byRef.has(r));
    const text = cleanLine(line.text);
    if (!text || !refs.length || /https?:\/\/|www\./i.test(text)) continue;
    if (opts.needFact && !refs.some((r) => r.startsWith('R'))) continue;
    if (unsupportedFigures(text, refs.map((r) => byRef.get(r)!)).length) continue;
    out.push({ text, refs });
    if (out.length >= opts.max) break;
  }
  return out;
}

export async function dueDiligenceAssist(
  db: Db,
  writer: DueDiligenceWriter | null,
  ask: { listingId: string } | { propertyId: string },
): Promise<{ summary: CheckedLine[]; questions: CheckedLine[]; facts: RecordFact[] }> {
  if (!writer) throw new DueDiligenceError('unavailable', 'The AI is not available right now. The records and the checklist above still apply.');
  const subject = await publicSubject(db, ask);
  if (!subject) throw new DueDiligenceError('not_found', 'That property is not available.');
  const facts = await dueDiligenceRecords(db, subject.propertyId, subject.listingId);
  const records = assistRecords(facts, subject.state);
  // An address not for sale has nobody to ask (the private offer is the way to its last agency).
  const wantQuestions = subject.listingId !== null;
  let draft: Awaited<ReturnType<DueDiligenceWriter>>;
  try {
    draft = await writer({ address: subject.address, records, wantQuestions });
  } catch {
    throw new DueDiligenceError('failed', 'The AI could not answer just now. Try again in a moment.');
  }
  return {
    summary: facts.length ? checkDraft(draft.summary, records, { max: MAX_SUMMARY_POINTS, needFact: true }) : [],
    questions: wantQuestions ? checkDraft(draft.questions, records, { max: MAX_QUESTIONS, needFact: false }) : [],
    facts,
  };
}
