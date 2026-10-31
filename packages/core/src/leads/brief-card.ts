import { and, eq, sql } from 'drizzle-orm';
import { buyerRequirement, contact, contactRole, lead, notification, proposedAction, type Db, type DbOrTx } from '@repo/db';
import type { Actor } from '../permissions';
import { createBuyerRequirement } from '../contacts/buyer-requirements';
import { requireEditableContact } from '../contacts/properties';
import type { BuyerRequirementInput } from '../contacts/contact-schema';
import type { ProposalCard } from '../assistant/schema';
import { briefFrom, type KeptFact, type LeadIntent } from './understand-facts';
import type { StoredUnderstanding } from './understand';

/**
 * ADR 0078 §6: what the AI understood reaches a contact ONLY through a card — `save_buyer_brief` — that shows the
 * brief as found, each figure beside the enquiry's words, and is approved by someone who may edit the contact.
 * Made by the lead page's "Save to … brief" and by the workflow step "Save the brief the AI found". It adds a
 * buyer requirement (never overwrites one) and the buyer role; nothing else.
 */

export const BRIEF_CARD_DAYS = 7;

export type SaveBriefArgs = { tool: 'save_buyer_brief'; contactId: string; leadId: string; brief: BuyerRequirementInput; addBuyerRole: boolean };

const money = (n: number) => `$${n.toLocaleString('en-AU')}`;
const LABEL: Partial<Record<KeptFact['field'], string>> = { price_from: 'Price from', price_to: 'Price to', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', suburbs: 'Suburbs', property_type: 'Type' };

/** The brief, its card and who gets it — or why there is none. Shared by the lead page and the workflow step. */
export async function proposeBriefCard(
  db: Db,
  actor: Actor,
  p: { leadId: string; key: string; origin: 'assistant' | 'workflow'; workflowName?: string },
  now = new Date(),
): Promise<{ cardId: string } | { briefError: string }> {
  if (!actor.agencyId) return { briefError: 'You may not do this.' };
  const [l] = await db
    .select({ id: lead.id, contactId: lead.contactId, status: lead.aiStatus, intent: lead.aiIntent, q: lead.aiQualification, listingId: lead.listingId })
    .from(lead)
    .where(and(eq(lead.id, p.leadId), eq(lead.agencyId, actor.agencyId)))
    .limit(1);
  if (!l) return { briefError: 'That lead was not found.' };
  if (!l.contactId) return { briefError: 'This lead has no contact to save a brief to.' };
  if (l.status !== 'done' || !l.q) return { briefError: 'The AI has not understood this enquiry (yet), so there is no brief to save.' };
  const stored = l.q as StoredUnderstanding;
  const brief = briefFrom({ intent: (l.intent ?? 'not_sure') as LeadIntent, facts: stored.facts ?? [] });
  if (!brief) return { briefError: 'The AI found nothing in the enquiry a buyer brief can hold.' };

  // The same permission as editing the contact, asked now — and again when the card is approved.
  let row;
  try {
    row = await requireEditableContact(db, actor, l.contactId);
  } catch (err) {
    return { briefError: err instanceof Error ? err.message : 'You may not change this contact.' };
  }
  const [{ n: held } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(buyerRequirement).where(eq(buyerRequirement.contactId, row.id));
  const [isBuyer] = await db.select({ role: contactRole.role }).from(contactRole).where(and(eq(contactRole.contactId, row.id), eq(contactRole.role, 'buyer'))).limit(1);

  const lines: ProposalCard['lines'] = [];
  for (const f of stored.facts ?? []) {
    const label = LABEL[f.field];
    if (!label) continue;
    const value = f.field === 'price_from' || f.field === 'price_to' ? money(f.value as number) : f.field === 'bedrooms' || f.field === 'bathrooms' ? `${f.value}+` : Array.isArray(f.value) ? f.value.join(', ') : String(f.value);
    lines.push({ label, value: `${value} — from “${f.quote}”` });
  }
  if (!isBuyer) lines.push({ label: 'Role', value: 'Buyer (added)' });
  const card: ProposalCard = {
    title: `Save ${row.name}’s brief${p.workflowName ? ` — from your workflow “${p.workflowName}”` : ''}`,
    contact: { id: row.id, name: row.name },
    lines,
    notes: [
      'Found by the AI in their enquiry: each figure is shown beside the words it was read from. Check them — what you approve is what is saved.',
      held ? `They already have ${held} brief${held === 1 ? '' : 's'}; this adds another (up to three) and changes none.` : 'Matching buyers uses this brief once it is saved.',
      'Nothing changes until you press Approve.',
    ],
  };
  const args: SaveBriefArgs = { tool: 'save_buyer_brief', contactId: row.id, leadId: l.id, brief, addBuyerRole: !isBuyer };
  const expiresAt = new Date(now.getTime() + BRIEF_CARD_DAYS * 86_400_000);
  const id = await db.transaction(async (tx) => {
    const [made] = await tx
      .insert(proposedAction)
      .values({ agencyId: actor.agencyId!, userId: actor.userId, contactId: row.id, tool: 'save_buyer_brief', args, card, origin: p.origin, idempotencyKey: `brief:${p.key}`, expiresAt })
      .onConflictDoNothing({ target: proposedAction.idempotencyKey })
      .returning({ id: proposedAction.id });
    const cardId = made?.id ?? (await tx.select({ id: proposedAction.id }).from(proposedAction).where(eq(proposedAction.idempotencyKey, `brief:${p.key}`)).limit(1))[0]!.id;
    if (p.origin === 'workflow') {
      await tx
        .insert(notification)
        .values({ userId: actor.userId, agencyId: actor.agencyId!, kind: 'workflow_draft', title: `${row.name}’s brief is waiting for you`.slice(0, 300), dedupeKey: `brief:${p.key}` })
        .onConflictDoNothing();
    }
    return cardId;
  });
  return { cardId: id };
}

/** The card, approved: the permission again (createBuyerRequirement asks it), the brief added, the buyer role. */
export async function runSaveBuyerBrief(tx: Db, actor: Actor, args: SaveBriefArgs): Promise<{ result: Record<string, unknown> }> {
  const { id } = await createBuyerRequirement(tx, actor, args.contactId, args.brief);
  if (args.addBuyerRole) {
    await tx.insert(contactRole).values({ contactId: args.contactId, role: 'buyer', source: 'manual', createdBy: actor.userId }).onConflictDoNothing();
  }
  return { result: { requirementId: id, contactId: args.contactId } };
}

/** The read-back: the requirement is there, on that contact, in the actor's agency. */
export async function verifySaveBuyerBrief(tx: DbOrTx, args: Record<string, unknown>, result: Record<string, unknown>): Promise<boolean> {
  const [r] = await tx
    .select({ id: buyerRequirement.id })
    .from(buyerRequirement)
    .innerJoin(contact, eq(contact.id, buyerRequirement.contactId))
    .where(and(eq(buyerRequirement.id, String(result.requirementId ?? '')), eq(buyerRequirement.contactId, String(args.contactId ?? ''))))
    .limit(1);
  return Boolean(r);
}
