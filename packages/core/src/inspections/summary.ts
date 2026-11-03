import type { DbOrTx } from '@repo/db';
import type { Actor } from '../permissions';
import { checkDraft, type AssistRecord, type CheckedLine, type DraftLine } from '../due-diligence/assist';
import { passesVerdictRule } from '../research/assist';
import { CHECK_MARK_LABEL, CHECKLISTS, type Checks, type ChecklistKind } from './checklist';
import { notebooksForSummary, type NotebookHome } from './notes';
import { dayText, kmText, localDay, planQuery, timeText, type DayPlan } from './plan';

/**
 * "Summarise my day" (ADR 0080, C6 decision 9): the model is handed ONLY the buyer's own marks and notes, one record
 * per home (N1…). Core keeps a line when it cites a record that exists, every figure in it is in what it cites, it
 * passes no verdict (C5's rule: no "best", no "worth", no "good buy"), and it names no condition — asbestos,
 * termites, "structurally sound" — the buyer did not write. The photos are never in a record. Nothing is stored.
 */

export const INSPECTION_SUMMARY_FEATURE = 'consumer:inspection_summary';
export const MAX_SUMMARY_LINES = 8;
const MAX_NOTES_IN_RECORD = 1500;

export type InspectionSummaryWriter = (input: { records: AssistRecord[] }) => Promise<{ lines: DraftLine[] }>;

export class InspectionSummaryError extends Error {
  constructor(
    public readonly code: 'not_found' | 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'InspectionSummaryError';
  }
}

/** Words about a home's condition the summary may use only when the buyer's own record has them. */
const CONDITION = /\b(structural(ly)?|sound|unsound|safe|unsafe|asbestos|termites?|subsidence|rot|rotten|leaks?|leaking|defects?|dangerous|compliant|illegal|unapproved)\b/gi;

export function conditionWordsSupported(text: string, cited: readonly string[]): boolean {
  const pool = cited.join(' ').toLowerCase();
  return [...text.matchAll(CONDITION)].every((m) => pool.includes(m[0].toLowerCase()));
}

/** One home's record, in the buyer's terms. Pure. */
export function notebookRecord(ref: string, input: { home: NotebookHome; checks: Checks; notes: string }): AssistRecord {
  const items = CHECKLISTS[input.home.kind as ChecklistKind];
  const line = (mark: 'issue' | 'fine' | 'unchecked') =>
    items
      .filter((i) => (input.checks[i.key]?.mark ?? 'unchecked') === mark)
      .map((i) => (input.checks[i.key]?.note ? `${i.label} ("${input.checks[i.key]!.note}")` : i.label))
      .join('; ');
  const notes = input.notes.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTES_IN_RECORD);
  return {
    ref,
    text: [
      `${input.home.address}.`,
      `Marked ${CHECK_MARK_LABEL.issue}: ${line('issue') || 'nothing'}.`,
      `Marked ${CHECK_MARK_LABEL.fine}: ${line('fine') || 'nothing'}.`,
      `${CHECK_MARK_LABEL.unchecked}: ${line('unchecked') || 'nothing'}.`,
      notes ? `The buyer's notes: "${notes}"` : 'No written notes.',
    ].join(' '),
  };
}

/** The model may write "[N2]" into a sentence; the reference is kept in `refs`, not the text. */
const stripRefs = (text: string) => text.replace(/\s*[[(]\s*N\d+(?:\s*[,;]\s*N\d+)*\s*[\])]/g, '').replace(/\s+/g, ' ').trim();

/** C2's check, the verdict rule, the condition rule. Pure. */
export function checkInspectionSummary(lines: readonly DraftLine[], records: readonly AssistRecord[]): CheckedLine[] {
  const byRef = new Map(records.map((r) => [r.ref, r.text]));
  const kept = lines
    .map((l) => ({ text: stripRefs(l.text), refs: l.refs }))
    .filter((l) => passesVerdictRule(l.text) && conditionWordsSupported(l.text, l.refs.flatMap((r) => (byRef.has(r) ? [byRef.get(r)!] : []))));
  return checkDraft(kept, records, { max: MAX_SUMMARY_LINES, needFact: false });
}

export type InspectionSummary = { lines: CheckedLine[]; homes: { ref: string; listingId: string; address: string }[] };

export async function runInspectionSummary(db: DbOrTx, actor: Actor, writer: InspectionSummaryWriter | null, listingIds?: readonly string[]): Promise<InspectionSummary> {
  const books = await notebooksForSummary(db, actor, listingIds);
  const used = books.filter((b) => b.notes.trim() || Object.keys(b.checks).length);
  if (!used.length) throw new InspectionSummaryError('not_found', 'There are no notes to summarise yet.');
  if (!writer) throw new InspectionSummaryError('unavailable', 'Summaries are switched off just now. Your notes are all here.');
  const records = used.map((b, i) => notebookRecord(`N${i + 1}`, b));
  let draft: { lines: DraftLine[] };
  try {
    draft = await writer({ records });
  } catch (err) {
    console.error('[inspection-summary] the writer failed', err);
    throw new InspectionSummaryError('failed', 'The summary could not be written just now. Try again in a moment.');
  }
  return { lines: checkInspectionSummary(draft.lines, records), homes: used.map((b, i) => ({ ref: `N${i + 1}`, listingId: b.home.listingId, address: b.home.address })) };
}

/**
 * What the guide's `plan_inspections` tool hands the model (C6 decision 5): the plan as plain facts, every time and
 * distance written by code, and the link to the plan page. Never a note.
 */
export type PlanToolResult = { day: string; stops: string[]; notThisDay: string[]; planPath: string; rules: string };

export function planToolResult(plan: DayPlan): PlanToolResult {
  const tz = plan.timeZone;
  const stops = plan.stops.map((s, i) => {
    const when = `${timeText(s.session.startsAt, tz)} – ${timeText(s.session.endsAt, tz)}`;
    const leg = i === 0 ? '' : s.metresFromPrevious === null ? ' (distance from the last stop unknown)' : ` (${kmText(s.metresFromPrevious)} in a straight line from the last stop)`;
    const flag =
      s.status === 'tight'
        ? ` TIGHT: only ${s.minutesLeft} minutes of the open home would be left.`
        : s.status === 'cant'
          ? ' CANNOT MAKE IT after the stop before.'
          : '';
    const other = s.otherTimes.length && s.status !== 'fits' && s.status !== 'start' ? ` Its other time that day: ${s.otherTimes.map((o) => timeText(o.startsAt, tz)).join(', ')}.` : '';
    return `${when}: ${s.home.address}${leg}.${flag}${other}`;
  });
  const notThisDay = plan.notThisDay.map((n) => `${n.home.address}: no open home ${n.reason === 'time_removed' ? 'any more at the chosen time' : 'that day'}${n.nextTime ? `; next open ${dayText(localDay(n.nextTime.startsAt, tz))} at ${timeText(n.nextTime.startsAt, tz)}` : ''}.`);
  return {
    day: dayText(plan.day),
    stops,
    notThisDay,
    planPath: `/inspections?${planQuery(plan)}`,
    rules:
      'Copy the times and distances exactly. Distances are straight lines, not driving — say so; never estimate a driving time. Times are set by the agents and can change. Link the plan page, where they can add it to a calendar and open the route.',
  };
}

