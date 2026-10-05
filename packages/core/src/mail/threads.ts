import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  lead,
  listingAgent,
  mailMessage,
  mailRead,
  mailThread,
  property,
  user,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type Resource } from '../permissions';
import { formatAddress } from '../listings/listing-schema';
import type { LeadKind, LeadStatus } from '../leads/list-leads';
import { snippet } from './body';
import type { AttachmentNote, MailFolder } from './mail-schema';

/**
 * Reading email conversations in the console (docs/adr/0016).
 *
 * The permission story is the lead inbox's, on purpose: a lead's conversation
 * IS the lead. `mail:read` has `lead:read`'s rule, an offer also needs
 * `lead:read_offer`, and an actor without `lead:read_all` is narrowed IN SQL to
 * the leads assigned to them or come through a listing they are named on — so
 * the counts never describe threads they cannot open. A thread with no lead is
 * mail to the agency's own address, and only `lead:read_all` sees those.
 */

const assignee = alias(user, 'assignee');
const author = alias(user, 'author');

export class MailError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid';
  constructor(code: MailError['code'], message: string) {
    super(message);
    this.name = 'MailError';
    this.code = code;
  }
}

/** One wording for "no such thread" and "not yours", so ids cannot be probed. */
export const THREAD_NOT_FOUND = () => new MailError('not_found', 'That conversation was not found');

/** The facts can() needs about a thread. */
export type ThreadAccessFacts = {
  id: string;
  agencyId: string;
  leadId: string | null;
  leadKind: LeadKind | null;
  assignedTo: string | null;
  listingId: string | null;
};

export function threadResource(t: ThreadAccessFacts): Resource {
  return {
    type: 'mail_thread',
    id: t.id,
    agencyId: t.agencyId,
    // A thread with no lead carries neither, so only an admin passes.
    listingId: t.leadId ? t.listingId : null,
    ...(t.leadId && t.assignedTo ? { ownerId: t.assignedTo } : {}),
  };
}

export function mayReadThread(actor: Actor, t: ThreadAccessFacts): boolean {
  const resource = threadResource(t);
  if (!can(actor, 'mail:read', resource)) return false;
  // Mail to the agency's own address has no lead to narrow it: admins only.
  if (!t.leadId && !can(actor, 'lead:read_all', resource)) return false;
  return t.leadKind !== 'offer' || can(actor, 'lead:read_offer', resource);
}

export function maySendOnThread(actor: Actor, t: ThreadAccessFacts): boolean {
  return mayReadThread(actor, t) && can(actor, 'mail:send', threadResource(t));
}

// ── The list ───────────────────────────────────────────────────────────────

export type MailThreadRow = {
  id: string;
  subject: string;
  contactName: string | null;
  contactEmail: string;
  leadId: string | null;
  leadKind: LeadKind | null;
  leadStatus: LeadStatus | null;
  assigneeName: string | null;
  /** The newest message's opening, quoted history cut. */
  preview: string;
  /** Whether the newest message is one of ours — the list says "You:". */
  lastFromUs: boolean;
  lastMessageAt: Date;
  unread: boolean;
};

export type MailThreadPage = {
  rows: MailThreadRow[];
  counts: { total: number; unread: number };
  /** What this actor's folder list may show. Decided here by can(), never in the UI. */
  folders: { offers: boolean; general: boolean };
};

export type ListThreadsOptions = { folder?: MailFolder; limit?: number; offset?: number };

const FORBIDDEN = () => new MailError('forbidden', 'You do not have permission to view this inbox');

/** Newer than when this person last opened it — one expression, used for the flag and the count. */
const unreadSql = sql<boolean>`${mailThread.lastInboundAt} > coalesce(${mailRead.lastReadAt}, '-infinity'::timestamptz)`;

/**
 * One page of the actor's conversations, newest activity first, with counts
 * for the whole folder. One statement: the counts are window functions and the
 * preview is a sub-select, so `query-count`'s rule holds.
 */
export async function listMailThreads(
  db: Db,
  actor: Actor,
  opts: ListThreadsOptions = {},
): Promise<MailThreadPage> {
  if (!actor.agencyId) throw FORBIDDEN();
  const inbox: Resource = { type: 'mail_thread', agencyId: actor.agencyId };
  if (!can(actor, 'mail:read', inbox)) throw FORBIDDEN();

  const readAll = can(actor, 'lead:read_all', inbox);
  const offers = can(actor, 'lead:read_offer', inbox);
  const folder = opts.folder ?? 'all';

  // A folder you may not open is a refusal, not an empty list — the leads
  // inbox's reasoning: empty reads as "nothing yet" and people stop looking.
  if (folder === 'offers' && !offers) throw FORBIDDEN();
  if (folder === 'general' && !readAll) throw FORBIDDEN();

  const filters = [eq(mailThread.agencyId, actor.agencyId)];
  if (!offers) filters.push(sql`${lead.kind} is distinct from 'offer'`);
  if (!readAll) {
    filters.push(isNotNull(mailThread.leadId));
    filters.push(
      or(
        eq(lead.assignedTo, actor.userId),
        inArray(
          lead.listingId,
          db
            .select({ id: listingAgent.listingId })
            .from(listingAgent)
            .where(eq(listingAgent.userId, actor.userId)),
        ),
      )!,
    );
  }
  if (folder === 'unread') filters.push(unreadSql);
  if (folder === 'mine') filters.push(eq(lead.assignedTo, actor.userId));
  if (folder === 'offers') filters.push(eq(lead.kind, 'offer'));
  if (folder === 'general') filters.push(isNull(mailThread.leadId));

  const rows = await db
    .select({
      id: mailThread.id,
      subject: mailThread.subject,
      contactName: mailThread.contactName,
      contactEmail: mailThread.contactEmail,
      leadId: mailThread.leadId,
      leadKind: lead.kind,
      leadStatus: lead.status,
      leadMessage: lead.message,
      assigneeName: assignee.name,
      assigneeEmail: assignee.email,
      lastMessageAt: mailThread.lastMessageAt,
      lastText: sql<string | null>`(
        select m.text from mail_message m
        where m.thread_id = ${mailThread.id}
        order by m.created_at desc, m.id desc limit 1
      )`,
      lastDirection: sql<'in' | 'out' | null>`(
        select m.direction from mail_message m
        where m.thread_id = ${mailThread.id}
        order by m.created_at desc, m.id desc limit 1
      )`,
      unread: unreadSql,
      totalCount: sql<number>`count(*) over()`,
      unreadCount: sql<number>`count(*) filter (where ${unreadSql}) over()`,
    })
    .from(mailThread)
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .leftJoin(assignee, eq(assignee.id, lead.assignedTo))
    .leftJoin(mailRead, and(eq(mailRead.threadId, mailThread.id), eq(mailRead.userId, actor.userId)))
    .where(and(...filters))
    .orderBy(desc(mailThread.lastMessageAt), desc(mailThread.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  const first = rows[0];
  return {
    rows: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      leadId: r.leadId,
      leadKind: (r.leadKind as LeadKind | null) ?? null,
      leadStatus: (r.leadStatus as LeadStatus | null) ?? null,
      assigneeName: r.assigneeName || r.assigneeEmail || null,
      // No messages yet: the lead's own words are the conversation so far.
      preview: snippet(r.lastText ?? r.leadMessage ?? ''),
      lastFromUs: r.lastDirection === 'out',
      lastMessageAt: new Date(r.lastMessageAt),
      // The driver may hand a boolean expression back as a string.
      unread: r.unread === true || (r.unread as unknown) === 't',
    })),
    counts: {
      // bigint arrives as a string (ARCHITECTURE § 5).
      total: Number(first?.totalCount ?? 0),
      unread: Number(first?.unreadCount ?? 0),
    },
    folders: { offers, general: readAll },
  };
}

// ── One thread ─────────────────────────────────────────────────────────────

export type MailMessageView = {
  id: string;
  direction: 'in' | 'out';
  channel: 'console' | 'email' | 'website' | null;
  status: 'received' | 'queued' | 'sent' | 'failed';
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  text: string;
  /** As received; render ONLY through `sandboxedEmailDocument`. */
  html: string | null;
  authorName: string | null;
  attachments: AttachmentNote[];
  error: string | null;
  createdAt: Date;
};

export type MailThreadView = {
  id: string;
  agencyId: string;
  subject: string;
  contactName: string | null;
  contactEmail: string;
  lead: {
    id: string;
    kind: LeadKind;
    status: LeadStatus;
    assignedTo: string | null;
    assigneeName: string | null;
    listingId: string | null;
    propertyId: string;
    address: string;
    phone: string | null;
    /** What they wrote on the form — the opening of the conversation. */
    message: string | null;
    createdAt: Date;
  } | null;
  messages: MailMessageView[];
  /** Decided by can(); the composer is drawn from this, the action re-checks. */
  maySend: boolean;
  /** Whether this actor may move the lead along / give it to someone. */
  mayUpdateLead: boolean;
  mayAssignLead: boolean;
};

/** The thread and the facts can() needs, in one statement. */
async function loadThreadHead(db: DbOrTx, actor: Actor, threadId: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(threadId)) return null;
  const [row] = await db
    .select({
      id: mailThread.id,
      agencyId: mailThread.agencyId,
      subject: mailThread.subject,
      contactName: mailThread.contactName,
      contactEmail: mailThread.contactEmail,
      leadId: mailThread.leadId,
      leadKind: lead.kind,
      leadStatus: lead.status,
      assignedTo: lead.assignedTo,
      assigneeName: assignee.name,
      assigneeEmail: assignee.email,
      listingId: lead.listingId,
      propertyId: lead.propertyId,
      phone: lead.phone,
      message: lead.message,
      leadCreatedAt: lead.createdAt,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
    })
    .from(mailThread)
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .leftJoin(property, eq(property.id, lead.propertyId))
    .leftJoin(assignee, eq(assignee.id, lead.assignedTo))
    // The agency in the WHERE, not only in can(): another agency's id is a miss.
    .where(and(eq(mailThread.id, threadId), eq(mailThread.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) return null;
  const facts: ThreadAccessFacts = {
    id: row.id,
    agencyId: row.agencyId,
    leadId: row.leadId,
    leadKind: (row.leadKind as LeadKind | null) ?? null,
    assignedTo: row.assignedTo,
    listingId: row.listingId,
  };
  return { row, facts };
}

/**
 * One conversation, oldest message first. Two statements: the thread, then its
 * messages — the second only once the first has said this actor may see it.
 */
export async function getMailThread(db: Db, actor: Actor, threadId: string): Promise<MailThreadView> {
  const head = await loadThreadHead(db, actor, threadId);
  if (!head || !mayReadThread(actor, head.facts)) throw THREAD_NOT_FOUND();
  const { row, facts } = head;

  const messages = await db
    .select({
      id: mailMessage.id,
      direction: mailMessage.direction,
      channel: mailMessage.channel,
      status: mailMessage.status,
      fromEmail: mailMessage.fromEmail,
      fromName: mailMessage.fromName,
      toEmails: mailMessage.toEmails,
      text: mailMessage.text,
      html: mailMessage.html,
      authorName: author.name,
      authorEmail: author.email,
      attachments: mailMessage.attachments,
      error: mailMessage.error,
      createdAt: mailMessage.createdAt,
    })
    .from(mailMessage)
    .leftJoin(author, eq(author.id, mailMessage.sentBy))
    .where(eq(mailMessage.threadId, row.id))
    .orderBy(asc(mailMessage.createdAt), asc(mailMessage.id));

  const leadResource: Resource | null = row.leadId
    ? {
        type: 'lead',
        id: row.leadId,
        agencyId: row.agencyId,
        listingId: row.listingId,
        ...(row.assignedTo ? { ownerId: row.assignedTo } : {}),
      }
    : null;

  return {
    id: row.id,
    agencyId: row.agencyId,
    subject: row.subject,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    lead:
      row.leadId && row.leadKind && row.leadStatus && row.propertyId && row.suburb
        ? {
            id: row.leadId,
            kind: row.leadKind as LeadKind,
            status: row.leadStatus as LeadStatus,
            assignedTo: row.assignedTo,
            assigneeName: row.assignedTo ? row.assigneeName || row.assigneeEmail : null,
            listingId: row.listingId,
            propertyId: row.propertyId,
            address: formatAddress({
              unit: row.unit,
              streetNumber: row.streetNumber,
              street: row.street,
              suburb: row.suburb,
              state: row.state ?? '',
              postcode: row.postcode ?? '',
            }),
            phone: row.phone,
            message: row.message,
            createdAt: new Date(row.leadCreatedAt as Date),
          }
        : null,
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      channel: m.channel,
      status: m.status,
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      toEmails: m.toEmails ?? [],
      text: m.text,
      html: m.html,
      authorName: m.authorName || m.authorEmail || null,
      attachments: Array.isArray(m.attachments) ? (m.attachments as AttachmentNote[]) : [],
      error: m.error,
      createdAt: new Date(m.createdAt),
    })),
    maySend: maySendOnThread(actor, facts),
    mayUpdateLead: leadResource ? can(actor, 'lead:update', leadResource) : false,
    mayAssignLead: leadResource ? can(actor, 'lead:assign', leadResource) : false,
  };
}

/** "I have seen this." Upserted, so opening a thread twice is one row. */
export async function markThreadRead(db: Db, actor: Actor, threadId: string): Promise<void> {
  const head = await loadThreadHead(db, actor, threadId);
  if (!head || !mayReadThread(actor, head.facts)) throw THREAD_NOT_FOUND();
  await db
    .insert(mailRead)
    // clock_timestamp(): the moment it was opened, compared against the
    // moment mail arrived — see the note in inbound.ts.
    .values({ threadId: head.row.id, userId: actor.userId, lastReadAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({
      target: [mailRead.threadId, mailRead.userId],
      set: { lastReadAt: sql`clock_timestamp()` },
    });
}

export { loadThreadHead as loadThreadAccess };
