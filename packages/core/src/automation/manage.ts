import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { automationEvent, buyerAutomation, searchSchedule, shortlist, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { consumerSkillBlocks, consumerSkillOffMessage } from '../consumer-skills';
import { readProposal, signProposal } from '../acting/signed';
import { automationInputSchema, describeAutomation, MAX_AUTOMATIONS, type AutomationInput } from './rules';

/**
 * Automation's reads and writes (ADR 0080, C8 decisions 8–11). `buyer_automation:*` is the owner's only. Creating one
 * needs Automation switched on (an "acts" skill); pausing, deleting, reading the log and Undo never do — a buyer can
 * always stop or reverse what was done in their name.
 */

export class AutomationError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'invalid' | 'limit' | 'not_found' | 'off',
    message: string,
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

function require(actor: Actor, action: 'buyer_automation:read' | 'buyer_automation:manage') {
  if (!can(actor, action, { type: 'buyer_automation', ownerId: actor.userId })) throw new AutomationError('forbidden', 'Sign in to manage your automations.');
}

export type AutomationSummary = { id: string; when: string; then: string; status: string; trigger: string; createdAt: Date };
export type AutomationLogLine = { id: string; automationWhen: string; address: string; listingId: string | null; propertyId: string | null; text: string; actionTaken: string | null; undoneAt: Date | null; createdAt: Date; emailedAt: Date | null };

const UUID = /^[0-9a-f-]{36}$/i;

export async function createAutomation(db: Db, actor: Actor, input: unknown): Promise<AutomationSummary> {
  require(actor, 'buyer_automation:manage');
  const block = (await consumerSkillBlocks(db, actor)).get('automation');
  if (block) throw new AutomationError('off', consumerSkillOffMessage('automation', block));
  const parsed = automationInputSchema.safeParse(input);
  if (!parsed.success) throw new AutomationError('invalid', parsed.error.issues[0]?.message ?? 'That automation could not be saved.');
  const a: AutomationInput = parsed.data;
  let searchName: string | null = null;
  if (a.searchId) {
    const [s] = await db.select({ name: searchSchedule.name }).from(searchSchedule).where(and(eq(searchSchedule.id, a.searchId), eq(searchSchedule.userId, actor.userId), eq(searchSchedule.kind, 'alert'))).limit(1);
    if (!s) throw new AutomationError('not_found', 'That saved search was not found.');
    searchName = s.name;
  }
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(buyerAutomation).where(eq(buyerAutomation.userId, actor.userId));
  if (Number(n) >= MAX_AUTOMATIONS) throw new AutomationError('limit', `You can have ${MAX_AUTOMATIONS} automations. Delete one to add another.`);
  const [row] = await db.insert(buyerAutomation).values({ userId: actor.userId, trigger: a.trigger, scope: a.scope, searchId: a.searchId ?? null, action: a.action, delivery: a.delivery, timeZone: a.timeZone }).returning();
  return { id: row!.id, ...describeAutomation(row!, searchName), status: row!.status, trigger: row!.trigger, createdAt: row!.createdAt };
}

export async function listAutomations(db: DbOrTx, actor: Actor): Promise<AutomationSummary[]> {
  require(actor, 'buyer_automation:read');
  const rows = await db
    .select({ a: buyerAutomation, searchName: searchSchedule.name })
    .from(buyerAutomation)
    .leftJoin(searchSchedule, eq(searchSchedule.id, buyerAutomation.searchId))
    .where(eq(buyerAutomation.userId, actor.userId))
    .orderBy(desc(buyerAutomation.createdAt), desc(buyerAutomation.id))
    .limit(MAX_AUTOMATIONS);
  return rows.map(({ a, searchName }) => ({ id: a.id, ...describeAutomation(a, searchName), status: a.status, trigger: a.trigger, createdAt: a.createdAt }));
}

export async function setAutomationStatus(db: DbOrTx, actor: Actor, id: string, status: 'active' | 'paused'): Promise<void> {
  require(actor, 'buyer_automation:manage');
  if (!UUID.test(id)) throw new AutomationError('not_found', 'That automation was not found.');
  // Resuming starts from now: what happened while it was paused is not reported later.
  const done = await db
    .update(buyerAutomation)
    .set({ status, ...(status === 'active' ? { checkedAt: sql`now()` } : {}), updatedAt: sql`now()` })
    .where(and(eq(buyerAutomation.id, id), eq(buyerAutomation.userId, actor.userId)))
    .returning({ id: buyerAutomation.id });
  if (!done.length) throw new AutomationError('not_found', 'That automation was not found.');
}

export async function deleteAutomation(db: DbOrTx, actor: Actor, id: string): Promise<void> {
  require(actor, 'buyer_automation:manage');
  if (!UUID.test(id)) return;
  await db.delete(buyerAutomation).where(and(eq(buyerAutomation.id, id), eq(buyerAutomation.userId, actor.userId)));
}

/** "What your automations did": newest first, with the address. One read. */
export async function automationLog(db: DbOrTx, actor: Actor, opts: { limit?: number } = {}): Promise<AutomationLogLine[]> {
  require(actor, 'buyer_automation:read');
  const rows = await db
    .select({
      e: automationEvent,
      a: buyerAutomation,
      searchName: searchSchedule.name,
      address: sql<string | null>`(select nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), '') || ', ' || p.suburb from property p where p.id = coalesce(${automationEvent.propertyId}, (select l.property_id from listing l where l.id = ${automationEvent.listingId})))`,
    })
    .from(automationEvent)
    .innerJoin(buyerAutomation, eq(buyerAutomation.id, automationEvent.automationId))
    .leftJoin(searchSchedule, eq(searchSchedule.id, buyerAutomation.searchId))
    .where(eq(automationEvent.userId, actor.userId))
    .orderBy(desc(automationEvent.createdAt), desc(automationEvent.id))
    .limit(opts.limit ?? 50);
  return rows.map(({ e, a, searchName, address }) => ({ id: e.id, automationWhen: describeAutomation(a, searchName).when, address: address ?? 'A home', listingId: e.listingId, propertyId: e.propertyId, text: e.text, actionTaken: e.actionTaken, undoneAt: e.undoneAt, createdAt: e.createdAt, emailedAt: e.emailedAt }));
}

/**
 * Undo (decision 9): the shortlist goes back as it was — an added home comes off, a removed one goes back with its note.
 * The automation stays on. One transaction; undoing twice does nothing.
 */
export async function undoAutomationEvent(db: Db, actor: Actor, eventId: string): Promise<void> {
  require(actor, 'buyer_automation:manage');
  if (!UUID.test(eventId)) throw new AutomationError('not_found', 'That was not found.');
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(automationEvent).where(and(eq(automationEvent.id, eventId), eq(automationEvent.userId, actor.userId))).limit(1).for('update');
    if (!e) throw new AutomationError('not_found', 'That was not found.');
    if (e.undoneAt || !e.actionTaken || !e.listingId) return;
    if (e.actionTaken === 'added') await tx.delete(shortlist).where(and(eq(shortlist.userId, actor.userId), eq(shortlist.listingId, e.listingId)));
    if (e.actionTaken === 'removed') {
      const note = (e.undo as { note?: string | null } | null)?.note ?? null;
      await tx.insert(shortlist).values({ userId: actor.userId, listingId: e.listingId, note }).onConflictDoNothing();
    }
    await tx.update(automationEvent).set({ undoneAt: sql`now()` }).where(eq(automationEvent.id, e.id));
  });
}

/** From an emailed link, with no session: the token is the authority (the Spam Act asks for no login). */
export async function pauseAutomationByOwner(db: DbOrTx, automationId: string, userId: string): Promise<boolean> {
  const rows = await db.update(buyerAutomation).set({ status: 'paused', updatedAt: sql`now()` }).where(and(eq(buyerAutomation.id, automationId), eq(buyerAutomation.userId, userId))).returning({ id: buyerAutomation.id });
  return rows.length > 0;
}

// ── the guide's card (decision 12) ──
export function signAutomationProposal(a: AutomationInput, secret: string, opts: { now?: Date } = {}): string {
  return signProposal('automation', a, secret, opts);
}

export async function acceptAutomationProposal(db: Db, actor: Actor, token: string, secret: string, opts: { now?: Date } = {}): Promise<AutomationSummary> {
  const a = readProposal('automation', token, z.unknown(), secret, opts);
  if (a === null) throw new AutomationError('invalid', 'That card has expired. Ask the guide again.');
  return createAutomation(db, actor, a);
}
