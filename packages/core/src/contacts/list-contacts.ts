import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { contact, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  CONTACT_PAGE_SIZE,
  CONTACT_ROLES,
  type ContactListQuery,
  type ContactRoleKind,
  type ContactSource,
} from './contact-schema';
import { auPhoneKey } from './phone';
import { visibleContactIdsSql } from './visibility';

const assignee = alias(user, 'assignee');

export class ContactError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'duplicate';
  /** On `duplicate`: the contact that already has this email. */
  readonly existingId?: string;
  constructor(code: ContactError['code'], message: string, existingId?: string) {
    super(message);
    this.name = 'ContactError';
    this.code = code;
    if (existingId) this.existingId = existingId;
  }
}

/** One wording for "no such contact" and "not yours", so ids cannot be probed. */
export const CONTACT_NOT_FOUND = () => new ContactError('not_found', 'That contact was not found');

export type ContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  roles: ContactRoleKind[];
  source: ContactSource;
  assignedTo: string | null;
  assigneeName: string | null;
  createdAt: Date;
};

export type ContactPage = {
  rows: ContactRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Decided by can(), so the screen never compares roles (#2). */
  mayCreate: boolean;
  /** Whether this directory is the whole agency's, and so may filter by any member. */
  seesAll: boolean;
};

/** `%`, `_` and `\` are LIKE syntax; a search for "50%" means the characters. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Parses `{buyer,seller}` or an array — what array_agg of an enum comes back as. */
function roleArray(value: unknown): ContactRoleKind[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.replace(/^\{|\}$/g, '').split(',')
      : [];
  return raw.filter((r): r is ContactRoleKind => (CONTACT_ROLES as readonly string[]).includes(r));
}

/**
 * One page of the contacts this actor may see, newest first, with the total.
 *
 * One statement: the total is a window function and the roles a sub-select,
 * so `query-count.test.ts` holds it to one query. Who is visible is
 * `visibleContactIdsSql` — the same rule can() applies to one contact.
 */
export async function listContacts(
  db: Db,
  actor: Actor,
  query: Partial<ContactListQuery> = {},
): Promise<ContactPage> {
  if (!actor.agencyId) throw new ContactError('forbidden', 'You do not have permission to view contacts');
  const directory = { type: 'contact', agencyId: actor.agencyId };
  if (!can(actor, 'contact:read', directory)) {
    throw new ContactError('forbidden', 'You do not have permission to view contacts');
  }
  const seesAll = can(actor, 'contact:read_all', directory);
  const page = Math.max(1, query.page ?? 1);

  const filters: SQL[] = [
    eq(contact.agencyId, actor.agencyId),
    isNull(contact.mergedIntoId),
    sql`${contact.id} in (${visibleContactIdsSql(actor)})`,
  ];

  const q = query.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    const key = auPhoneKey(q);
    filters.push(
      or(
        sql`${contact.name} ilike ${pattern}`,
        sql`${contact.email} ilike ${pattern}`,
        sql`${contact.phone} ilike ${pattern}`,
        ...(key ? [eq(contact.phoneKey, key)] : []),
      )!,
    );
  }
  if (query.role) {
    filters.push(
      sql`exists (select 1 from contact_role r where r.contact_id = ${contact.id} and r.role = ${query.role})`,
    );
  }
  if (query.source) filters.push(eq(contact.source, query.source));
  if (query.assigned === 'me') filters.push(eq(contact.assignedTo, actor.userId));
  else if (query.assigned === 'none') filters.push(isNull(contact.assignedTo));
  // Somebody else's book is a filter only on a directory that already holds it.
  else if (query.assigned && seesAll) filters.push(eq(contact.assignedTo, query.assigned));

  const rows = await db
    .select({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      source: contact.source,
      assignedTo: contact.assignedTo,
      assigneeName: assignee.name,
      assigneeEmail: assignee.email,
      createdAt: contact.createdAt,
      roles: sql<unknown>`(
        select array_agg(r.role order by r.role) from contact_role r where r.contact_id = ${contact.id}
      )`,
      total: sql<number>`count(*) over()`,
    })
    .from(contact)
    .leftJoin(assignee, eq(assignee.id, contact.assignedTo))
    .where(and(...filters))
    .orderBy(desc(contact.createdAt), desc(contact.id))
    .limit(CONTACT_PAGE_SIZE)
    .offset((page - 1) * CONTACT_PAGE_SIZE);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      roles: roleArray(r.roles),
      source: r.source as ContactSource,
      assignedTo: r.assignedTo,
      assigneeName: r.assignedTo ? r.assigneeName || r.assigneeEmail || null : null,
      createdAt: new Date(r.createdAt),
    })),
    // bigint arrives as a string (ARCHITECTURE § 5).
    total: Number(rows[0]?.total ?? 0),
    page,
    pageSize: CONTACT_PAGE_SIZE,
    mayCreate: can(actor, 'contact:create', directory),
    seesAll,
  };
}

export { roleArray };
