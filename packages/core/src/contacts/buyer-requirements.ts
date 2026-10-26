import { and, asc, count, desc, eq } from 'drizzle-orm';
import { buyerRequirement, contact, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import {
  buyerRequirementSchema,
  describeRequirement,
  MAX_REQUIREMENTS_PER_CONTACT,
  REQUIREMENT_STATUSES,
  type BuyerRequirementInput,
  type BuyerRequirementValues,
  type RequirementChannel,
  type RequirementFacts,
  type RequirementStatus,
} from './contact-schema';
import type { ReadableContact } from './get-contact';
import { ContactError } from './list-contacts';
import { requireEditableContact } from './properties';
import { recordActivity } from './write-contacts';

/**
 * What a buyer or tenant is looking for (ADR 0055). Whoever may read the contact reads its briefs;
 * whoever may change the contact (`contact:update` — their assigned agent, or an admin) writes them.
 * No action of its own: a brief is part of the contact, as its linked properties are.
 *
 * Every figure is the agent's, stored in a typed column so a new listing can be matched against it
 * in SQL (ADR 0055 §2, built in Feature 2) — never parsed out of words, never estimated.
 */

export type BuyerRequirementView = RequirementFacts & {
  id: string;
  note: string | null;
  status: RequirementStatus;
  /** The line the profile and the timeline show, rendered from the figures above. */
  summary: string;
  createdAt: Date;
  updatedAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** numeric columns arrive as strings (ARCHITECTURE § 5); null stays null, never NaN. */
const num = (v: string | number | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type Row = typeof buyerRequirement.$inferSelect;

function toView(r: Row): BuyerRequirementView {
  const facts: RequirementFacts = {
    channel: r.channel as RequirementChannel,
    priceMin: num(r.priceMin),
    priceMax: num(r.priceMax),
    minBedrooms: r.minBedrooms,
    minBathrooms: num(r.minBathrooms),
    suburbs: r.suburbs,
    propertyTypes: r.propertyTypes,
  };
  return {
    ...facts,
    id: r.id,
    note: r.note,
    status: (REQUIREMENT_STATUSES as readonly string[]).includes(r.status) ? (r.status as RequirementStatus) : 'active',
    summary: describeRequirement(facts),
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

/** A contact's briefs, active first, newest first. One statement. */
export async function listBuyerRequirements(db: Db, _actor: Actor, c: ReadableContact): Promise<BuyerRequirementView[]> {
  // ReadableContact is the proof `contact:read` passed; nothing here widens it.
  const rows = await db
    .select()
    .from(buyerRequirement)
    .where(and(eq(buyerRequirement.contactId, c.id), eq(buyerRequirement.agencyId, c.agencyId)))
    .orderBy(asc(buyerRequirement.status), desc(buyerRequirement.createdAt))
    .limit(MAX_REQUIREMENTS_PER_CONTACT * 2);
  return rows.map(toView);
}

function parse(input: BuyerRequirementInput): BuyerRequirementValues {
  const parsed = buyerRequirementSchema.safeParse(input);
  if (!parsed.success) throw new ContactError('invalid', parsed.error.issues[0]?.message ?? 'Check the requirements');
  return parsed.data;
}

/** The columns a parsed brief writes. numeric columns take strings, so precision is never lost. */
function columns(v: BuyerRequirementValues) {
  return {
    channel: v.channel,
    priceMin: v.priceMin === undefined ? null : v.priceMin.toFixed(2),
    priceMax: v.priceMax === undefined ? null : v.priceMax.toFixed(2),
    minBedrooms: v.minBedrooms ?? null,
    minBathrooms: v.minBathrooms === undefined ? null : v.minBathrooms.toFixed(1),
    suburbs: v.suburbs,
    propertyTypes: v.propertyTypes,
    note: v.note ?? null,
    status: v.status,
  };
}

/** The timeline's words for a brief: the figures, never the free-text note. */
function summaryOf(v: BuyerRequirementValues): string {
  return describeRequirement({
    channel: v.channel,
    priceMin: v.priceMin ?? null,
    priceMax: v.priceMax ?? null,
    minBedrooms: v.minBedrooms ?? null,
    minBathrooms: v.minBathrooms ?? null,
    suburbs: v.suburbs,
    propertyTypes: v.propertyTypes,
  });
}

export async function createBuyerRequirement(
  db: Db,
  actor: Actor,
  contactId: string,
  input: BuyerRequirementInput,
): Promise<{ id: string }> {
  const row = await requireEditableContact(db, actor, contactId);
  const v = parse(input);
  return db.transaction(async (tx) => {
    // The contact row, locked: two tabs adding a brief at once cannot both pass the cap below.
    await tx.select({ id: contact.id }).from(contact).where(eq(contact.id, row.id)).for('update');
    const [held] = await tx
      .select({ n: count() })
      .from(buyerRequirement)
      .where(and(eq(buyerRequirement.contactId, row.id), eq(buyerRequirement.agencyId, row.agencyId)));
    if ((held?.n ?? 0) >= MAX_REQUIREMENTS_PER_CONTACT) {
      throw new ContactError('invalid', `A contact holds at most ${MAX_REQUIREMENTS_PER_CONTACT} sets of requirements — remove one first`);
    }
    const [made] = await tx
      .insert(buyerRequirement)
      .values({ agencyId: row.agencyId, contactId: row.id, createdBy: actor.userId, ...columns(v) })
      .returning({ id: buyerRequirement.id });
    await recordActivity(tx, actor, row.agencyId, row.id, 'requirement_added', { requirementId: made!.id, summary: summaryOf(v) });
    return { id: made!.id };
  });
}

/** Replace a brief's figures. The whole brief is sent, as the form holds it. */
export async function updateBuyerRequirement(
  db: Db,
  actor: Actor,
  contactId: string,
  requirementId: string,
  input: BuyerRequirementInput,
): Promise<void> {
  const row = await requireEditableContact(db, actor, contactId);
  if (!UUID.test(requirementId)) throw REQUIREMENT_NOT_FOUND();
  const v = parse(input);
  await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(buyerRequirement)
      .set({ ...columns(v), updatedAt: new Date() })
      .where(
        and(
          eq(buyerRequirement.id, requirementId),
          eq(buyerRequirement.contactId, row.id),
          eq(buyerRequirement.agencyId, row.agencyId),
        ),
      )
      .returning({ id: buyerRequirement.id });
    if (!changed) throw REQUIREMENT_NOT_FOUND();
    await recordActivity(tx, actor, row.agencyId, row.id, 'requirement_updated', { requirementId, summary: summaryOf(v) });
  });
}

/** Pause a brief (kept, matched against nothing) or take it up again. */
export async function setBuyerRequirementStatus(
  db: Db,
  actor: Actor,
  contactId: string,
  requirementId: string,
  status: RequirementStatus,
): Promise<void> {
  const row = await requireEditableContact(db, actor, contactId);
  if (!UUID.test(requirementId)) throw REQUIREMENT_NOT_FOUND();
  if (!(REQUIREMENT_STATUSES as readonly string[]).includes(status)) throw new ContactError('invalid', 'That is not a status');
  await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(buyerRequirement)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(buyerRequirement.id, requirementId),
          eq(buyerRequirement.contactId, row.id),
          eq(buyerRequirement.agencyId, row.agencyId),
        ),
      )
      .returning();
    if (!changed) throw REQUIREMENT_NOT_FOUND();
    await recordActivity(tx, actor, row.agencyId, row.id, 'requirement_updated', {
      requirementId,
      summary: toView(changed).summary,
      status,
    });
  });
}

/** Remove a brief. It is a preference, not a record of anything said — so it goes, with a line on the timeline. */
export async function deleteBuyerRequirement(db: Db, actor: Actor, contactId: string, requirementId: string): Promise<void> {
  const row = await requireEditableContact(db, actor, contactId);
  if (!UUID.test(requirementId)) throw REQUIREMENT_NOT_FOUND();
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(buyerRequirement)
      .where(
        and(
          eq(buyerRequirement.id, requirementId),
          eq(buyerRequirement.contactId, row.id),
          eq(buyerRequirement.agencyId, row.agencyId),
        ),
      )
      .returning();
    if (!gone) throw REQUIREMENT_NOT_FOUND();
    await recordActivity(tx, actor, row.agencyId, row.id, 'requirement_removed', { requirementId, summary: toView(gone).summary });
  });
}

const REQUIREMENT_NOT_FOUND = () => new ContactError('not_found', 'Those requirements were not found — they may have been removed');
