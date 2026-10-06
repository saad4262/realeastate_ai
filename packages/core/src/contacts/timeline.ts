import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  activity,
  lead,
  mailMessage,
  mailThread,
  note,
  property,
  user,
  type Db,
} from '@repo/db';
import type { Actor } from '../permissions';
import { leadScopeFilters, type LeadKind } from '../leads/list-leads';
import { threadScopeFilters } from '../mail/threads';
import { snippet } from '../mail/body';
import { formatAddress } from '../listings/listing-schema';
import { activityKindSchema, type ActivityKind } from './contact-schema';
import type { ReadableContact } from './get-contact';
import { noteVisibleSql, privateActivityVisibleSql } from './notes';

/**
 * One person's history, newest first (ADR 0018): their enquiries and offers,
 * every email either way, the notes written about them, and the `activity`
 * rows for things with no other home.
 *
 * ONE statement — a UNION ALL of four selects, ordered and limited once — so
 * the page costs one round trip however much has happened. Nothing is copied
 * into a timeline table: each entry is read from the row that already holds it.
 *
 * Each part carries the SAME scope as its own screen: leads through
 * `leadScopeFilters` (an agent never sees an offer, or another agent's lead),
 * emails through `threadScopeFilters`. A timeline is another way of showing a
 * lead or an email, so it may only show what the inbox would.
 */

export type TimelineItem =
  | {
      type: 'lead';
      id: string;
      at: Date;
      kind: LeadKind;
      address: string;
      propertyId: string;
      threadId: string | null;
      message: string | null;
      who: string | null;
    }
  | {
      type: 'email';
      id: string;
      at: Date;
      direction: 'in' | 'out';
      failed: boolean;
      subject: string;
      preview: string;
      threadId: string;
      who: string | null;
    }
  | { type: 'note'; id: string; at: Date; body: string; who: string | null; isPrivate: boolean }
  | {
      type: 'activity';
      id: string;
      at: Date;
      kind: ActivityKind;
      payload: Record<string, unknown>;
      who: string | null;
    };

/** `nextBefore` is an opaque cursor: the last item's time and id, so a tie at a page edge is neither repeated nor skipped. */
export type TimelinePage = { items: TimelineItem[]; nextBefore: string | null };

function parseCursor(raw: string | undefined): { at: string; id: string } | null {
  const [at, id] = (raw ?? '').split('|');
  if (!at || !id || !/^[0-9: .+-]{10,40}$/.test(at) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at, id };
}

export const TIMELINE_PAGE_SIZE = 30;

type Row = {
  /** `at` as Postgres prints it — microseconds kept, so the cursor is exact. */
  at_key: string;
  type: string;
  at: Date | string;
  id: string;
  sub: string | null;
  title: string | null;
  body: string | null;
  ref: string | null;
  ref2: string | null;
  who: string | null;
  unit: string | null;
  street_number: string | null;
  street: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
};

const author = alias(user, 'author');

/** The same eleven columns in the same order, so the four parts can be unioned. */
const nulls = {
  unit: sql<null>`null::text`.as('unit'),
  street_number: sql<null>`null::text`.as('street_number'),
  street: sql<null>`null::text`.as('street'),
  suburb: sql<null>`null::text`.as('suburb'),
  state: sql<null>`null::text`.as('state'),
  postcode: sql<null>`null::text`.as('postcode'),
};

export async function listContactTimeline(
  db: Db,
  actor: Actor,
  contact: ReadableContact,
  opts: { before?: string; limit?: number } = {},
): Promise<TimelinePage> {
  const limit = Math.min(Math.max(opts.limit ?? TIMELINE_PAGE_SIZE, 1), 100);

  const leads = db
    .select({
      type: sql<string>`'lead'`.as('type'),
      at: sql<Date>`${lead.createdAt}`.as('at'),
      id: sql<string>`${lead.id}`.as('id'),
      sub: sql<string>`${lead.kind}::text`.as('sub'),
      title: sql<null>`null::text`.as('title'),
      body: sql<string | null>`left(${lead.message}, 600)`.as('body'),
      ref: sql<string>`${lead.propertyId}`.as('ref'),
      ref2: sql<string | null>`${mailThread.id}`.as('ref2'),
      who: sql<string>`${lead.name}`.as('who'),
      unit: sql<string | null>`${property.unit}`.as('unit'),
      street_number: sql<string | null>`${property.streetNumber}`.as('street_number'),
      street: sql<string | null>`${property.street}`.as('street'),
      suburb: sql<string>`${property.suburb}`.as('suburb'),
      state: sql<string>`${property.state}`.as('state'),
      postcode: sql<string>`${property.postcode}`.as('postcode'),
    })
    .from(lead)
    .innerJoin(property, eq(property.id, lead.propertyId))
    .leftJoin(mailThread, eq(mailThread.leadId, lead.id))
    .where(and(eq(lead.contactId, contact.id), ...leadScopeFilters(db, actor)));

  const emails = db
    .select({
      type: sql<string>`'email'`.as('type'),
      at: sql<Date>`${mailMessage.createdAt}`.as('at'),
      id: sql<string>`${mailMessage.id}`.as('id'),
      sub: sql<string>`${mailMessage.direction}::text || ':' || ${mailMessage.status}::text`.as('sub'),
      title: sql<string>`${mailMessage.subject}`.as('title'),
      body: sql<string>`left(${mailMessage.text}, 600)`.as('body'),
      ref: sql<string>`${mailMessage.threadId}`.as('ref'),
      ref2: sql<null>`null::uuid`.as('ref2'),
      who: sql<string | null>`coalesce(${author.name}, ${mailMessage.fromName}, ${mailMessage.fromEmail})`.as('who'),
      ...nulls,
    })
    .from(mailMessage)
    .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .leftJoin(author, eq(author.id, mailMessage.sentBy))
    .where(and(eq(mailThread.contactId, contact.id), ...threadScopeFilters(db, actor)));

  const notes = db
    .select({
      type: sql<string>`'note'`.as('type'),
      at: sql<Date>`${note.createdAt}`.as('at'),
      id: sql<string>`${note.id}`.as('id'),
      sub: sql<string>`case when ${note.isPrivate} then 'private' else 'shared' end`.as('sub'),
      title: sql<null>`null::text`.as('title'),
      body: sql<string>`${note.body}`.as('body'),
      ref: sql<null>`null::uuid`.as('ref'),
      ref2: sql<null>`null::uuid`.as('ref2'),
      who: sql<string | null>`coalesce(${author.name}, ${author.email})`.as('who'),
      ...nulls,
    })
    .from(note)
    .leftJoin(author, eq(author.id, note.authorId))
    .where(
      and(
        eq(note.contactId, contact.id),
        eq(note.agencyId, contact.agencyId),
        isNull(note.deletedAt),
        noteVisibleSql(actor),
      ),
    );

  const activities = db
    .select({
      type: sql<string>`'activity'`.as('type'),
      at: sql<Date>`${activity.occurredAt}`.as('at'),
      id: sql<string>`${activity.id}`.as('id'),
      sub: sql<string>`${activity.kind}`.as('sub'),
      title: sql<null>`null::text`.as('title'),
      body: sql<string>`${activity.payload}::text`.as('body'),
      ref: sql<null>`null::uuid`.as('ref'),
      ref2: sql<null>`null::uuid`.as('ref2'),
      who: sql<string | null>`coalesce(${author.name}, ${author.email})`.as('who'),
      ...nulls,
    })
    .from(activity)
    .leftJoin(author, eq(author.id, activity.actorId))
    .where(and(eq(activity.contactId, contact.id), eq(activity.agencyId, contact.agencyId), privateActivityVisibleSql(actor)));

  const cursor = parseCursor(opts.before);
  const before = cursor ? sql`where (t.at, t.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``;
  const rows = await db.execute<Row>(sql`
    select t.*, t.at::text as at_key from (
      (${leads}) union all (${emails}) union all (${notes}) union all (${activities})
    ) t
    ${before}
    order by t.at desc, t.id desc
    limit ${limit + 1}
  `);

  const items = rows.slice(0, limit).map(toItem).filter((i): i is TimelineItem => i !== null);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { items, nextBefore: last ? `${last.at_key}|${last.id}` : null };
}

function toItem(r: Row): TimelineItem | null {
  const at = new Date(r.at);
  switch (r.type) {
    case 'lead':
      return {
        type: 'lead',
        id: r.id,
        at,
        kind: r.sub as LeadKind,
        address: formatAddress({
          unit: r.unit,
          streetNumber: r.street_number,
          street: r.street,
          suburb: r.suburb ?? '',
          state: r.state ?? '',
          postcode: r.postcode ?? '',
        }),
        propertyId: r.ref as string,
        threadId: r.ref2,
        message: r.body,
        who: r.who,
      };
    case 'email': {
      const [direction, status] = (r.sub ?? 'in:received').split(':');
      return {
        type: 'email',
        id: r.id,
        at,
        direction: direction === 'out' ? 'out' : 'in',
        failed: status === 'failed',
        subject: r.title ?? '',
        preview: snippet(r.body ?? ''),
        threadId: r.ref as string,
        who: r.who,
      };
    }
    case 'note':
      return { type: 'note', id: r.id, at, body: r.body ?? '', who: r.who, isPrivate: r.sub === 'private' };
    case 'activity': {
      const kind = activityKindSchema.safeParse(r.sub);
      // A kind this code no longer knows is left out rather than shown wrong.
      if (!kind.success) return null;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(r.body ?? '{}') as Record<string, unknown>;
      } catch {
        payload = {};
      }
      return { type: 'activity', id: r.id, at, kind: kind.data, payload, who: r.who };
    }
    default:
      return null;
  }
}
