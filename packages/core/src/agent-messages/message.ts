import { and, asc, count, eq, gt, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agency, guideMessage, inspection, listing, property, user, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { consumerSkillBlocks, consumerSkillOffMessage } from '../consumer-skills';
import { publicListing } from '../listings/search-listings';
import { priceText } from '../due-diligence/records';
import { stateTimeZone } from '../inspections/plan';
import { createEnquiry } from '../leads/create-enquiry';
import { customerThreadForListing, replyAsCustomer } from '../mail';
import { readProposal, signProposal } from '../acting/signed';
import { checkAgentDraft, MAX_MESSAGE_CHARS, templateMessage } from './check';

/**
 * Agent AI (ADR 0080, C8 decisions 1–4; mock docs/mocks/consumer-acting.html#draft). The guide drafts; the buyer reads,
 * edits and presses Send; nothing reaches an agency before that. The draft's sources are the buyer's own words and the
 * listing's public facts — nothing else is handed to the writer — and core checks the result. The send goes through the
 * doors that exist: a reply in the buyer's conversation about this home, else an ordinary enquiry; name, email and
 * phone from the account. Five a day.
 */

export const AGENT_MESSAGE_FEATURE = 'consumer:agent_message';
export const GUIDE_MESSAGES_PER_DAY = 5;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export class AgentMessageError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'off' | 'not_found' | 'limit' | 'invalid' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'AgentMessageError';
  }
}

export type MessageFacts = { listingId: string; address: string; agencyName: string; facts: string[] };

/** The listing's public facts a draft may use: address, price, upcoming open times. Null unless public. Two reads. */
export async function messageFacts(db: DbOrTx, listingId: string, now: Date = new Date()): Promise<MessageFacts | null> {
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) return null;
  const [row] = await db
    .select({
      street: sql<string | null>`nullif(trim(concat(case when ${property.unit} is not null then ${property.unit} || '/' end, concat_ws(' ', ${property.streetNumber}, ${property.street}))), '')`,
      suburb: property.suburb,
      state: property.state,
      agencyName: agency.name,
      priceDisplay: listing.priceDisplay,
      priceFrom: listing.priceFrom,
      priceTo: listing.priceTo,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(and(eq(listing.id, listingId), publicListing()))
    .limit(1);
  if (!row) return null;
  const opens = await db
    .select({ startsAt: inspection.startsAt })
    .from(inspection)
    .where(and(eq(inspection.listingId, listingId), eq(inspection.kind, 'open'), gt(inspection.startsAt, now)))
    .orderBy(asc(inspection.startsAt))
    .limit(4);
  const tz = stateTimeZone(row.state);
  const when = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: tz });
  const address = [row.street, row.suburb].filter(Boolean).join(', ');
  return {
    listingId,
    address,
    agencyName: row.agencyName,
    facts: [`Address: ${address} ${row.state}`, `Price: ${priceText(row.priceDisplay, row.priceFrom, row.priceTo)}`, ...opens.map((o) => `Open home: ${when.format(o.startsAt)}`)],
  };
}

/** The writer port (packages/ai): the buyer's words and the listing's facts in, a message out — or null. */
export type AgentDraftWriter = (input: { address: string; agencyName: string; listingFacts: string[]; buyerWords: string; latest: string }, ctx: { userId: string }) => Promise<string | null>;

export type MessageDraft = { listingId: string; address: string; agencyName: string; text: string; source: 'model' | 'template'; token: string; sentToday: number; perDay: number };

async function sentToday(db: DbOrTx, userId: string, now: Date): Promise<number> {
  const [r] = await db.select({ n: count() }).from(guideMessage).where(and(eq(guideMessage.userId, userId), gte(guideMessage.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000))));
  return Number(r?.n ?? 0);
}

/**
 * Draft a message (decisions 1–2). `buyerWords` is everything the buyer wrote in this conversation, `latest` their last
 * message — the template's words. The skill must be on and the buyer signed in; the result is a card, never a send.
 */
export async function draftAgentMessage(
  db: Db,
  actor: Actor,
  input: { listingId: string; buyerWords: string; latest: string },
  deps: { writer?: AgentDraftWriter | null; secret: string; now?: Date },
): Promise<MessageDraft> {
  if (!can(actor, 'guide_message:send', { type: 'guide_message', ownerId: actor.userId })) throw new AgentMessageError('forbidden', 'Sign in to send a message to the agent.');
  const block = (await consumerSkillBlocks(db, actor)).get('agent_messages');
  if (block) throw new AgentMessageError('off', consumerSkillOffMessage('agent_messages', block));
  const now = deps.now ?? new Date();
  const facts = await messageFacts(db, input.listingId, now);
  if (!facts) throw new AgentMessageError('not_found', 'That home is not advertised on this site now.');
  const buyerWords = input.buyerWords.slice(-4000);
  let text: string | null = null;
  if (deps.writer) {
    const out = await deps.writer({ address: facts.address, agencyName: facts.agencyName, listingFacts: facts.facts, buyerWords, latest: input.latest }, { userId: actor.userId }).catch(() => null);
    if (out && checkAgentDraft(out, { buyerWords, listingFacts: facts.facts }).ok) text = out.trim();
  }
  return {
    listingId: facts.listingId,
    address: facts.address,
    agencyName: facts.agencyName,
    text: text ?? templateMessage(facts.address, input.latest),
    source: text ? 'model' : 'template',
    token: signProposal('message', { listingId: facts.listingId }, deps.secret, { now, ttlMs: DRAFT_TTL_MS }),
    sentToday: await sentToday(db, actor.userId, now),
    perDay: GUIDE_MESSAGES_PER_DAY,
  };
}

const messageProposal = z.object({ listingId: z.string().uuid() }).strict();

export type GuideSendResult = { kind: 'enquiry'; leadId: string; listingId: string } | { kind: 'reply'; threadId: string; messageId: string; listingId: string };

/**
 * Send what the buyer pressed Send on (decisions 1, 3, 4) — the text as they left it. The token proves the guide drafted
 * it for this listing (it counts against the five, and their own copy says so); the agency's copy is an ordinary
 * enquiry or reply. Everything written in one transaction; the caller tells the agency after.
 */
export async function sendGuideMessage(db: Db, actor: Actor, input: { token: string; text: string }, deps: { secret: string; now?: Date }): Promise<GuideSendResult> {
  if (!can(actor, 'guide_message:send', { type: 'guide_message', ownerId: actor.userId })) throw new AgentMessageError('forbidden', 'Sign in to send a message to the agent.');
  const block = (await consumerSkillBlocks(db, actor)).get('agent_messages');
  if (block) throw new AgentMessageError('off', consumerSkillOffMessage('agent_messages', block));
  const now = deps.now ?? new Date();
  const p = readProposal('message', input.token, messageProposal, deps.secret, { now });
  if (!p) throw new AgentMessageError('expired', 'That draft has expired. Ask the guide again.');
  const text = String(input.text ?? '').trim();
  if (text.length < 10 || text.length > MAX_MESSAGE_CHARS) throw new AgentMessageError('invalid', `Write between 10 and ${MAX_MESSAGE_CHARS} characters.`);
  if ((await sentToday(db, actor.userId, now)) >= GUIDE_MESSAGES_PER_DAY) throw new AgentMessageError('limit', `You can send ${GUIDE_MESSAGES_PER_DAY} messages drafted by the guide a day. You can still use the enquiry form on the listing.`);
  const [me] = await db.select({ email: user.email, name: user.name, phone: user.phone }).from(user).where(eq(user.id, actor.userId)).limit(1);
  if (!me?.email) throw new AgentMessageError('forbidden', 'Your account has no email address to send from.');
  const who = { userId: actor.userId, email: me.email };
  const threadId = await customerThreadForListing(db, who, p.listingId);

  return db.transaction(async (tx) => {
    if (threadId) {
      const sent = await replyAsCustomer(tx as unknown as Db, who, threadId, { body: text });
      await tx.insert(guideMessage).values({ userId: actor.userId, listingId: p.listingId, threadId: sent.threadId });
      return { kind: 'reply' as const, threadId: sent.threadId, messageId: sent.messageId, listingId: p.listingId };
    }
    const name = me.name?.trim() && me.name.trim().length >= 2 ? me.name.trim() : me.email.split('@')[0]!.slice(0, 120).padEnd(2, '.');
    const { leadId } = await createEnquiry(tx, p.listingId, { name, email: me.email, ...(me.phone ? { phone: me.phone } : {}), message: text }, { userId: actor.userId });
    await tx.insert(guideMessage).values({ userId: actor.userId, listingId: p.listingId, leadId });
    return { kind: 'enquiry' as const, leadId, listingId: p.listingId };
  });
}

/** Which of the buyer's conversations began or continued with a guide-drafted message — their copy's note (decision 4). */
export async function guideDraftedThreads(db: DbOrTx, actor: Actor): Promise<{ threadIds: Set<string>; leadIds: Set<string> }> {
  if (!can(actor, 'guide_message:send', { type: 'guide_message', ownerId: actor.userId })) return { threadIds: new Set(), leadIds: new Set() };
  const rows = await db.select({ threadId: guideMessage.threadId, leadId: guideMessage.leadId }).from(guideMessage).where(eq(guideMessage.userId, actor.userId)).limit(500);
  return { threadIds: new Set(rows.flatMap((r) => (r.threadId ? [r.threadId] : []))), leadIds: new Set(rows.flatMap((r) => (r.leadId ? [r.leadId] : []))) };
}
