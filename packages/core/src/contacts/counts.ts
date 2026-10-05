import { and, eq, isNull, sql } from 'drizzle-orm';
import { contactProperty, lead, mailThread, note, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { leadScopeFilters } from '../leads/list-leads';
import { threadScopeFilters } from '../mail/threads';
import type { ReadableContact } from './get-contact';

export type ContactCounts = { enquiries: number; conversations: number; notes: number; properties: number };

/**
 * The overview's figures, in one statement. Enquiries and conversations are
 * counted under the inbox's own scope, so the overview never says "3
 * enquiries" to somebody whose Enquiries tab would show one.
 */
export async function contactCounts(db: Db, actor: Actor, c: ReadableContact): Promise<ContactCounts> {
  const leads = db
    .select({ n: sql<number>`count(*)` })
    .from(lead)
    .where(and(eq(lead.contactId, c.id), ...leadScopeFilters(db, actor)));
  const threads = db
    .select({ n: sql<number>`count(*)` })
    .from(mailThread)
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .where(and(eq(mailThread.contactId, c.id), ...threadScopeFilters(db, actor)));
  const notes = db
    .select({ n: sql<number>`count(*)` })
    .from(note)
    .where(and(eq(note.contactId, c.id), eq(note.agencyId, c.agencyId), isNull(note.deletedAt)));
  const linked = db
    .select({ n: sql<number>`count(distinct ${contactProperty.propertyId})` })
    .from(contactProperty)
    .where(eq(contactProperty.contactId, c.id));
  const [row] = await db.execute<{ e: string; t: string; n: string; p: string }>(sql`
    select (${leads}) as e, (${threads}) as t, (${notes}) as n, (${linked}) as p
  `);
  // bigint arrives as a string (ARCHITECTURE § 5).
  return {
    enquiries: Number(row?.e ?? 0),
    conversations: Number(row?.t ?? 0),
    notes: Number(row?.n ?? 0),
    properties: Number(row?.p ?? 0),
  };
}
