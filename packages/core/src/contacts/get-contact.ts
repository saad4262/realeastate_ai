import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { contact, user, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import type { ContactRoleKind, ContactSource } from './contact-schema';
import { CONTACT_NOT_FOUND, roleArray } from './list-contacts';
import {
  contactAccessColumns,
  contactResource,
  idArray,
  type ContactAccessFacts,
} from './visibility';

const assignee = alias(user, 'assignee');
const consentBy = alias(user, 'consent_by');

const UUID = /^[0-9a-f-]{36}$/i;

/** The contact row and the facts can() needs, in one statement. Agency in the WHERE. */
export async function loadContactHead(db: DbOrTx, actor: Actor, contactId: string) {
  if (!actor.agencyId || !UUID.test(contactId)) return null;
  const [row] = await db
    .select({
      id: contact.id,
      agencyId: contact.agencyId,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      phoneKey: contact.phoneKey,
      source: contact.source,
      assignedTo: contact.assignedTo,
      assigneeName: assignee.name,
      assigneeEmail: assignee.email,
      nextAction: contact.nextAction,
      nextActionAt: contact.nextActionAt,
      marketingConsentAt: contact.marketingConsentAt,
      marketingConsentNote: contact.marketingConsentNote,
      consentByName: consentBy.name,
      consentByEmail: consentBy.email,
      emailOptOutAt: contact.emailOptOutAt,
      mergedIntoId: contact.mergedIntoId,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      roles: sql<unknown>`(
        select array_agg(r.role order by r.role) from contact_role r where r.contact_id = ${contact.id}
      )`,
      inferredRoles: sql<unknown>`(
        select array_agg(r.role order by r.role) from contact_role r
        where r.contact_id = ${contact.id} and r.source = 'inferred'
      )`,
      ...contactAccessColumns(contact.id, contact.agencyId),
    })
    .from(contact)
    .leftJoin(assignee, eq(assignee.id, contact.assignedTo))
    .leftJoin(consentBy, eq(consentBy.id, contact.marketingConsentBy))
    .where(and(eq(contact.id, contactId), eq(contact.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) return null;
  const facts: ContactAccessFacts = {
    id: row.id,
    agencyId: row.agencyId,
    assignedTo: row.assignedTo,
    leadAssigneeIds: idArray(row.leadAssigneeIds),
    listingAgentIds: idArray(row.listingAgentIds),
  };
  return { row, facts };
}

export type DuplicateSuggestion = { id: string; name: string; email: string | null; phone: string | null };

export type ContactView = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: ContactSource;
  roles: ContactRoleKind[];
  /** Tags read off what the person did, not chosen by anyone — shown as such. */
  inferredRoles: ContactRoleKind[];
  assignedTo: string | null;
  assigneeName: string | null;
  nextAction: string | null;
  nextActionAt: Date | null;
  marketingConsent: { at: Date; note: string | null; byName: string | null } | null;
  emailOptOutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Same phone, different person — for an admin to merge or leave (ADR 0018). */
  possibleDuplicates: DuplicateSuggestion[];
  /** Decided by can(); the screen draws from these, the actions re-check. */
  mayUpdate: boolean;
  mayAssign: boolean;
  mayMerge: boolean;
  mayNote: boolean;
};

/**
 * One contact, if this actor may see it. Two statements at most: the contact,
 * then — only for somebody who may merge — others sharing its phone key.
 * A merged contact answers with where it went, so an old link still lands.
 */
export async function getContact(
  db: Db,
  actor: Actor,
  contactId: string,
): Promise<ContactView | { mergedInto: string }> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head) throw CONTACT_NOT_FOUND();
  const { row, facts } = head;
  const resource = contactResource(facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (row.mergedIntoId) return { mergedInto: row.mergedIntoId };

  const mayMerge = can(actor, 'contact:merge', resource);
  const possibleDuplicates =
    mayMerge && row.phoneKey
      ? await db
          .select({ id: contact.id, name: contact.name, email: contact.email, phone: contact.phone })
          .from(contact)
          .where(
            and(
              eq(contact.agencyId, row.agencyId),
              eq(contact.phoneKey, row.phoneKey),
              ne(contact.id, row.id),
              isNull(contact.mergedIntoId),
            ),
          )
          .limit(10)
      : [];

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source as ContactSource,
    roles: roleArray(row.roles),
    inferredRoles: roleArray(row.inferredRoles),
    assignedTo: row.assignedTo,
    assigneeName: row.assignedTo ? row.assigneeName || row.assigneeEmail || null : null,
    nextAction: row.nextAction,
    nextActionAt: row.nextActionAt ? new Date(row.nextActionAt) : null,
    marketingConsent: row.marketingConsentAt
      ? {
          at: new Date(row.marketingConsentAt),
          note: row.marketingConsentNote,
          byName: row.consentByName || row.consentByEmail || null,
        }
      : null,
    emailOptOutAt: row.emailOptOutAt ? new Date(row.emailOptOutAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    possibleDuplicates,
    mayUpdate: can(actor, 'contact:update', resource),
    mayAssign: can(actor, 'contact:assign', resource),
    mayMerge,
    mayNote: can(actor, 'note:create', resource),
  };
}
