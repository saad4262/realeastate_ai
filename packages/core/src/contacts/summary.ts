import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { ACTIVITY_LABELS } from './contact-schema';
import { CONTACT_NOT_FOUND, ContactError } from './list-contacts';
import { listContactTimeline, type TimelineItem } from './timeline';
import { contactResource } from './visibility';
import { getContact, loadContactHead } from './get-contact';

/**
 * The profile's summary (ADR 0083 §8): the one model call here, on a button. The model is handed the person's history
 * with every figure masked, has no tools, and its answer is thrown away if it holds a figure (#4). It reaches only the
 * person who pressed the button, labelled, and is not stored (#7). A private note is left out, whoever is asking.
 */

export const CONTACT_SUMMARY_FEATURE = 'contact:summary';
const HISTORY_ITEMS = 40;

export type ContactSummarizer = (input: {
  lines: string[];
  agencyId: string;
  userId: string;
}) => Promise<{ text: string } | { text: null; rejected: string }>;

const FIGURE = /\$?\d[\d,.:/-]*/g;
/** Figures become a mark, so there is no number in the input to repeat. Pure. */
export const maskFigures = (text: string) => text.replace(FIGURE, '[figure]').replace(/\s+/g, ' ').trim();

/** One history entry as one line for the model, oldest first when mapped over a reversed list. Null for nothing to say. Pure. */
export function summaryLine(item: TimelineItem): string | null {
  switch (item.type) {
    case 'lead':
      return `ENQUIRY (${item.kind}): ${maskFigures(item.message ?? 'no message')}`;
    case 'email':
      return `EMAIL ${item.direction === 'in' ? 'FROM THEM' : 'TO THEM'}: ${maskFigures(`${item.subject}. ${item.preview}`)}`;
    case 'sms':
      return `TEXT ${item.direction === 'in' ? 'FROM THEM' : 'TO THEM'}: ${maskFigures(item.body)}`;
    case 'note':
      return item.isPrivate ? null : `AGENT'S NOTE: ${maskFigures(item.body)}`;
    case 'call':
      return `MISSED CALL FROM THEM`;
    case 'activity':
      if (item.kind === 'call_logged') {
        const note = typeof item.payload.note === 'string' ? item.payload.note : '';
        return `CALL LOGGED: ${maskFigures(note || 'no note')}`;
      }
      return item.kind === 'requirement_added' || item.kind === 'requirement_updated' ? `BRIEF: ${ACTIVITY_LABELS[item.kind]}` : null;
    case 'site':
      return item.kind === 'search' ? 'SEARCHED THE WEBSITE' : item.kind === 'saved' ? 'SAVED A LISTING' : 'OPENED A LISTING';
  }
}

function capFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function summarizeContact(
  db: Db,
  actor: Actor,
  contactId: string,
  summarizer: ContactSummarizer | null,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<{ text: string }> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact_summary:write', resource)) throw new ContactError('forbidden', 'You can read this contact but not ask for a summary');
  if (!summarizer) throw new ContactError('invalid', 'Summaries are not set up on this server.');

  const env = opts.env ?? process.env;
  const since = new Date((opts.now ?? new Date()).getTime() - 24 * 3_600_000).toISOString();
  const [spend] = await db.execute<{ agency: string; total: string }>(sql`
    select
      coalesce((select sum(r.cost_usd) from ai_run r where r.agency_id = ${head.row.agencyId} and r.feature = ${CONTACT_SUMMARY_FEATURE} and r.created_at >= ${since}), 0) as agency,
      coalesce((select sum(r.cost_usd) from ai_run r where r.created_at >= ${since}), 0) as total`);
  if (Number(spend?.total ?? 0) >= capFrom(env.AI_DAILY_BUDGET_USD, 5) || Number(spend?.agency ?? 0) >= capFrom(env.CONTACT_SUMMARY_DAILY_BUDGET_USD_PER_AGENCY, 2)) {
    throw new ContactError('invalid', 'Today’s AI budget is used up. Try again tomorrow.');
  }

  const view = await getContact(db, actor, contactId);
  if ('mergedInto' in view) throw CONTACT_NOT_FOUND();
  const { items } = await listContactTimeline(db, actor, view.ref, { limit: HISTORY_ITEMS });
  const lines = [...items].reverse().map(summaryLine).filter((l): l is string => Boolean(l));
  if (!lines.some((l) => !l.startsWith('OPENED') && !l.startsWith('SEARCHED') && !l.startsWith('SAVED'))) {
    throw new ContactError('invalid', 'There is not enough history to summarise yet.');
  }
  let answer: Awaited<ReturnType<ContactSummarizer>>;
  try {
    answer = await summarizer({ lines, agencyId: head.row.agencyId, userId: actor.userId });
  } catch (err) {
    console.error('[contacts] summary failed', err instanceof Error ? err.message : err);
    throw new ContactError('invalid', 'The summary could not be written. Try again.');
  }
  if (answer.text === null) throw new ContactError('invalid', 'The summary did not pass its checks, so it is not shown. Try again.');
  return { text: answer.text };
}
