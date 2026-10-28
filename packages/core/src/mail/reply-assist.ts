import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { getMailThread } from './threads';
import { stripQuotedReply } from './body';
import { holderOf, isSkillOn } from '../skill-switches/switches';
import { skillOffMessage } from '../skill-switches/catalog';
import { MAX_REPLY_INSTRUCTION, REPLY_TONES, type ReplyTone } from './mail-schema';

/**
 * The inbox's assistant (ADR 0062, ROADMAP 1.6): a summary of one conversation and a reply drafted into
 * the composer — both on a button, both under the "AI email drafts" switch (ADR 0058), both read only
 * what is in this conversation. Nothing here sends: the agent edits the draft and presses Send.
 * The model is behind two interfaces implemented in packages/ai (#3); core numbers the messages, checks
 * the answer and keeps every figure honest.
 */

export { REPLY_TONES, type ReplyTone } from './mail-schema';
export const INBOX_SUMMARY_FEATURE = 'inbox:summary';
export const INBOX_DRAFT_FEATURE = 'inbox:draft';
/** At most this many of the newest messages go to the model; older ones are left out. */
export const ASSIST_MESSAGE_LIMIT = 12;
const MESSAGE_CHARS = 2500;

export type AssistMessage = { n: number; from: 'contact' | 'agent'; name: string; at: string; text: string };
export type SummaryPoint = { text: string; messages: number[] };
export type ThreadSummarizer = (input: { messages: AssistMessage[]; agencyId: string; userId: string }) => Promise<{ points: SummaryPoint[] }>;
export type ReplyDrafter = (input: {
  messages: AssistMessage[];
  tone: ReplyTone;
  instruction: string | null;
  contactFirstName: string;
  agentName: string;
  agencyId: string;
  userId: string;
}) => Promise<{ body: string }>;

export class ReplyAssistError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'unavailable' | 'budget' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ReplyAssistError';
  }
}

function capFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Today's spend on the inbox assistant for this agency, and on AI overall, under their caps. */
export async function inboxAiAllowed(db: Db, agencyId: string, env: NodeJS.ProcessEnv, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const [row] = await db.execute<{ agency: string; total: string }>(sql`
    select
      coalesce((select sum(r.cost_usd) from ai_run r where r.agency_id = ${agencyId} and r.feature in (${INBOX_SUMMARY_FEATURE}, ${INBOX_DRAFT_FEATURE}) and r.created_at >= ${since}), 0) as agency,
      coalesce((select sum(r.cost_usd) from ai_run r where r.created_at >= ${since}), 0) as total`);
  return Number(row?.total ?? 0) < capFrom(env.AI_DAILY_BUDGET_USD, 5) && Number(row?.agency ?? 0) < capFrom(env.INBOX_AI_DAILY_BUDGET_USD_PER_AGENCY, 2);
}

/** The figure-like tokens in a text: prices, times, counts, dates' parts. */
const FIGURE = /\$?\d[\d,]*(?:\.\d+)?(?:\s?(?:am|pm|k|m)\b)?/gi;
const norm = (s: string) => s.toLowerCase().replace(/[$,\s]/g, '');

/** Every figure in `text` that appears nowhere in `sources`. Pure. */
export function unsupportedFigures(text: string, sources: readonly string[]): string[] {
  const pool = norm(sources.join(' '));
  const bad = new Set<string>();
  for (const m of text.matchAll(FIGURE)) if (!pool.includes(norm(m[0]))) bad.add(m[0]);
  return [...bad];
}

/** A drafted reply's figures that the conversation and the agent's own words don't give become [brackets]. Pure. */
export function bracketUnsupported(body: string, sources: readonly string[]): string {
  const pool = norm(sources.join(' '));
  return body.replace(FIGURE, (tok) => (pool.includes(norm(tok)) ? tok : '[check this figure]'));
}

/**
 * Keep a summary point only when it cites at least one message that exists, and any figure it states is
 * in the messages it cites. At most five. Pure.
 */
export function checkSummary(points: readonly SummaryPoint[], messages: readonly AssistMessage[]): SummaryPoint[] {
  const byN = new Map(messages.map((m) => [m.n, m.text]));
  const out: SummaryPoint[] = [];
  for (const p of points) {
    const cited = [...new Set(p.messages)].filter((n) => byN.has(n)).sort((a, b) => a - b);
    const text = p.text.trim().slice(0, 300);
    if (!text || !cited.length) continue;
    if (unsupportedFigures(text, cited.map((n) => byN.get(n)!)).length) continue;
    out.push({ text, messages: cited });
    if (out.length === 5) break;
  }
  return out;
}

/** The conversation as numbered messages, the form message first — what the person sees, newest last. */
function numbered(view: Awaited<ReturnType<typeof getMailThread>>): AssistMessage[] {
  const contact = view.contactName || view.contactEmail;
  const all: Omit<AssistMessage, 'n'>[] = [];
  if (view.lead?.message) all.push({ from: 'contact', name: contact, at: view.lead.createdAt.toISOString(), text: view.lead.message });
  for (const m of view.messages) {
    // Kept even when empty, so "message 3" is the third card on screen.
    const text = (m.direction === 'in' ? stripQuotedReply(m.text) : m.text).trim() || '(no text — an attachment or an empty message)';
    all.push({ from: m.direction === 'in' ? 'contact' : 'agent', name: m.direction === 'in' ? contact : m.authorName ?? 'The agent', at: m.createdAt.toISOString(), text });
  }
  return all.map((m, i) => ({ ...m, n: i + 1, text: m.text.slice(0, MESSAGE_CHARS) })).slice(-ASSIST_MESSAGE_LIMIT);
}

async function context(db: Db, actor: Actor, threadId: string, forReply: boolean, env: NodeJS.ProcessEnv, now: Date) {
  let view;
  try {
    view = await getMailThread(db, actor, threadId);
  } catch {
    throw new ReplyAssistError('forbidden', 'That conversation was not found.');
  }
  if (forReply && !view.maySend) throw new ReplyAssistError('forbidden', 'Replying to this conversation is up to whoever it is assigned to.');
  if (!(await isSkillOn(db, actor, 'ai_email_drafts'))) throw new ReplyAssistError('forbidden', skillOffMessage('ai_email_drafts', holderOf(actor.membershipRole)));
  const messages = numbered(view);
  if (!messages.length) throw new ReplyAssistError('unavailable', 'There is nothing in this conversation to work from yet.');
  if (!(await inboxAiAllowed(db, view.agencyId, env, now))) throw new ReplyAssistError('budget', 'Today’s AI budget for the inbox is used up. Try again tomorrow, or write it yourself.');
  return { view, messages };
}

/** "What's going on": up to five points, each citing the messages it came from. */
export async function summarizeThread(
  db: Db,
  actor: Actor,
  threadId: string,
  summarizer: ThreadSummarizer | null,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<{ points: SummaryPoint[] }> {
  if (!summarizer) throw new ReplyAssistError('unavailable', 'The assistant is not set up on this server.');
  const { view, messages } = await context(db, actor, threadId, false, opts.env ?? process.env, opts.now ?? new Date());
  let raw: { points: SummaryPoint[] };
  try {
    raw = await summarizer({ messages, agencyId: view.agencyId, userId: actor.userId });
  } catch (err) {
    console.error('[inbox] summary failed', err instanceof Error ? err.message : err);
    throw new ReplyAssistError('failed', 'The summary could not be written. Try again.');
  }
  const points = checkSummary(raw.points, messages);
  if (!points.length) throw new ReplyAssistError('failed', 'The summary could not be checked against the messages, so it is not shown. Try again.');
  return { points };
}

/** A reply, drafted into the composer for the agent to edit and send. Figures it can't source become [brackets]. */
export async function draftReply(
  db: Db,
  actor: Actor,
  threadId: string,
  input: { tone: ReplyTone; instruction?: string | null },
  drafter: ReplyDrafter | null,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<{ body: string; bracketed: number }> {
  if (!drafter) throw new ReplyAssistError('unavailable', 'The assistant is not set up on this server.');
  if (!(REPLY_TONES as readonly string[]).includes(input.tone)) throw new ReplyAssistError('unavailable', 'Pick a tone.');
  const instruction = input.instruction?.trim().slice(0, MAX_REPLY_INSTRUCTION) || null;
  const { view, messages } = await context(db, actor, threadId, true, opts.env ?? process.env, opts.now ?? new Date());
  const contact = view.contactName || view.contactEmail;
  const contactFirstName = contact.includes('@') ? '' : contact.trim().split(/\s+/)[0] ?? '';
  const agentName = view.messages.find((m) => m.direction === 'out' && m.authorName)?.authorName ?? '';
  let raw: { body: string };
  try {
    raw = await drafter({ messages, tone: input.tone, instruction, contactFirstName, agentName, agencyId: view.agencyId, userId: actor.userId });
  } catch (err) {
    console.error('[inbox] draft failed', err instanceof Error ? err.message : err);
    throw new ReplyAssistError('failed', 'The reply could not be drafted. Try again, or write it yourself.');
  }
  const sources = [...messages.map((m) => m.text), instruction ?? '', contactFirstName, agentName];
  const body = bracketUnsupported(raw.body.trim().slice(0, 5000), sources);
  return { body, bracketed: (body.match(/\[check this figure\]/g) ?? []).length };
}
