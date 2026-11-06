import { and, eq, isNull, sql } from 'drizzle-orm';
import { buyerRequirement, contactProperty, lead, mailThread, note, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { leadScopeFilters } from '../leads/list-leads';
import { threadScopeFilters } from '../mail/threads';
import type { ReadableContact } from './get-contact';
import { noteVisibleSql } from './notes';
import { belongsToContactSql, numberScopeSql } from './communications';
import { siteRowsSql } from './site-history';

export type ContactCounts = {
  enquiries: number;
  conversations: number;
  notes: number;
  properties: number;
  requirements: number;
  /** ADR 0083: each under its own tab's scope. */
  sms: number;
  calls: number;
  activity: number;
};

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
    .where(and(eq(note.contactId, c.id), eq(note.agencyId, c.agencyId), isNull(note.deletedAt), noteVisibleSql(actor)));
  const linked = db
    .select({ n: sql<number>`count(distinct ${contactProperty.propertyId})` })
    .from(contactProperty)
    .where(eq(contactProperty.contactId, c.id));
  // Active briefs only (ADR 0055): a paused one is kept, but it is not what they are looking for now.
  const briefs = db
    .select({ n: sql<number>`count(*)` })
    .from(buyerRequirement)
    .where(and(eq(buyerRequirement.contactId, c.id), eq(buyerRequirement.agencyId, c.agencyId), eq(buyerRequirement.status, 'active')));
  const texts = sql`select count(*) from sms_message m join phone_number pn on pn.id = m.phone_number_id
    where m.agency_id = ${c.agencyId} and ${belongsToContactSql('m.contact_id', 'm.counterpart', c.id)} and ${numberScopeSql(actor, c.agencyId)}`;
  const calls = sql`select
    (select count(*) from phone_call pc join phone_number pn on pn.id = pc.phone_number_id
      where pc.agency_id = ${c.agencyId} and pc.kind = 'missed' and ${belongsToContactSql('pc.contact_id', 'pc.from_e164', c.id)} and ${numberScopeSql(actor, c.agencyId)})
    + (select count(*) from activity a where a.contact_id = ${c.id} and a.agency_id = ${c.agencyId} and a.kind = 'call_logged')`;
  const site = sql`select count(*) from (${siteRowsSql(actor, c.id)}) sr`;
  const [row] = await db.execute<{ e: string; t: string; n: string; p: string; r: string; s: string; c: string; a: string }>(sql`
    select (${leads}) as e, (${threads}) as t, (${notes}) as n, (${linked}) as p, (${briefs}) as r, (${texts}) as s, (${calls}) as c, (${site}) as a
  `);
  // bigint arrives as a string (ARCHITECTURE § 5).
  return {
    enquiries: Number(row?.e ?? 0),
    conversations: Number(row?.t ?? 0),
    notes: Number(row?.n ?? 0),
    properties: Number(row?.p ?? 0),
    requirements: Number(row?.r ?? 0),
    sms: Number(row?.s ?? 0),
    calls: Number(row?.c ?? 0),
    activity: Number(row?.a ?? 0),
  };
}
