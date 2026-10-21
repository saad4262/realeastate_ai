import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { requirePlatformView } from './admin';

/**
 * Email activity for the admin console (ADR 0051): what an agency — or one
 * member of it — sent and received, from `mail_message` and `email_batch`.
 *
 * Under a `platform` view only. The agency's view (userId = the admin) counts
 * the whole agency; a member's view counts what they sent and the replies in
 * the conversations they wrote in.
 *
 * What is NOT here, because nothing records it: delivered, opened, bounced.
 * An outbound message is `queued`, `sent` (the provider took it) or `failed`.
 *
 * Every figure is SQL (#4). Five statements, started together by the caller's
 * page; none per row.
 */

export type EmailActivityDays = 7 | 30 | 90;

export type EmailActivity = {
  days: EmailActivityDays;
  totals: { sent: number; failed: number; queued: number; received: number; replies: number; viaGmail: number };
  /** Outbound by what composed it: `conversation` (a person's own reply/new email), a template, an invitation… */
  byKind: { kind: string; sent: number; failed: number }[];
  /** Agency view only: each member's outbound. Empty for a member's view. */
  byMember: { userId: string; name: string; sent: number; failed: number; lastSentAt: Date | null }[];
  batches: {
    id: string;
    name: string;
    byName: string;
    status: string;
    preparedAt: Date;
    approvedAt: Date | null;
    recipients: number;
    sent: number;
    failed: number;
    skipped: number;
    queued: number;
  }[];
  recent: {
    id: string;
    threadId: string;
    direction: 'in' | 'out';
    status: string;
    subject: string;
    to: string[];
    from: string;
    kind: string | null;
    sentVia: string | null;
    byName: string | null;
    error: string | null;
    at: Date;
  }[];
};

const n = (v: unknown) => Number(v ?? 0);

export function parseEmailDays(raw: string | undefined): EmailActivityDays {
  return raw === '7' ? 7 : raw === '90' ? 90 : 30;
}

export async function emailActivity(db: Db, view: Actor, opts: { days?: EmailActivityDays; recent?: number } = {}): Promise<EmailActivity> {
  requirePlatformView(view);
  const days = opts.days ?? 30;
  const agencyId = view.agencyId;
  const member = view.userId !== view.viewerId ? view.userId : null;
  const since = sql`now() - make_interval(days => ${days})`;
  // A member's mail: what they sent, and what came in on a conversation they wrote in.
  const scope = member
    ? sql`and ((m.direction = 'out' and m.sent_by = ${member})
           or (m.direction = 'in' and exists (select 1 from mail_message o where o.thread_id = m.thread_id and o.direction = 'out' and o.sent_by = ${member})))`
    : sql``;

  const totalsQ = db.execute<Record<string, number>>(sql`
    select
      count(*) filter (where m.direction = 'out' and m.status = 'sent')::int as sent,
      count(*) filter (where m.direction = 'out' and m.status = 'failed')::int as failed,
      count(*) filter (where m.direction = 'out' and m.status = 'queued')::int as queued,
      count(*) filter (where m.direction = 'in')::int as received,
      count(*) filter (where m.direction = 'in' and exists (
        select 1 from mail_message o where o.thread_id = m.thread_id and o.direction = 'out' and o.created_at < m.created_at
      ))::int as replies,
      count(*) filter (where m.direction = 'out' and m.sent_via = 'gmail')::int as "viaGmail"
    from mail_message m
    where m.agency_id = ${agencyId} and m.created_at > ${since} ${scope}`);

  const byKindQ = db.execute<{ kind: string; sent: number; failed: number }>(sql`
    select coalesce(m.kind, 'conversation') as kind,
      count(*) filter (where m.status = 'sent')::int as sent,
      count(*) filter (where m.status = 'failed')::int as failed
    from mail_message m
    where m.agency_id = ${agencyId} and m.direction = 'out' and m.created_at > ${since} ${scope}
    group by 1 order by 2 desc`);

  const byMemberQ = member
    ? Promise.resolve([] as { user_id: string; name: string; sent: number; failed: number; last_sent_at: string | null }[])
    : db.execute<{ user_id: string; name: string; sent: number; failed: number; last_sent_at: string | null }>(sql`
        select m.sent_by as user_id, coalesce(nullif(u.name, ''), u.email) as name,
          count(*) filter (where m.status = 'sent')::int as sent,
          count(*) filter (where m.status = 'failed')::int as failed,
          max(m.created_at) as last_sent_at
        from mail_message m join "user" u on u.id = m.sent_by
        where m.agency_id = ${agencyId} and m.direction = 'out' and m.created_at > ${since}
        group by m.sent_by, u.name, u.email order by 3 desc`);

  const batchesQ = db.execute<Record<string, unknown>>(sql`
    select b.id, b.status, b.prepared_at, b.approved_at,
      coalesce(b.template_snapshot->>'name', b.template_snapshot->>'subject', 'Bulk email') as name,
      coalesce(nullif(u.name, ''), u.email) as by_name,
      (select count(*)::int from email_batch_recipient r where r.batch_id = b.id) as recipients,
      (select count(*)::int from email_batch_recipient r where r.batch_id = b.id and r.status = 'sent') as sent,
      (select count(*)::int from email_batch_recipient r where r.batch_id = b.id and r.status = 'failed') as failed,
      (select count(*)::int from email_batch_recipient r where r.batch_id = b.id and r.status = 'skipped') as skipped,
      (select count(*)::int from email_batch_recipient r where r.batch_id = b.id and r.status in ('queued', 'sending')) as queued
    from email_batch b join "user" u on u.id = b.user_id
    where b.agency_id = ${agencyId} and b.prepared_at > ${since} ${member ? sql`and b.user_id = ${member}` : sql``}
    order by b.prepared_at desc limit 50`);

  const recentQ = db.execute<Record<string, unknown>>(sql`
    select m.id, m.thread_id, m.direction, m.status, m.subject, m.to_emails, m.from_email, m.kind, m.sent_via, m.error, m.created_at,
      (select coalesce(nullif(u.name, ''), u.email) from "user" u where u.id = m.sent_by) as by_name
    from mail_message m
    where m.agency_id = ${agencyId} and m.created_at > ${since} ${scope}
    order by m.created_at desc limit ${Math.min(opts.recent ?? 50, 200)}`);

  const [[t], byKind, byMember, batches, recent] = await Promise.all([totalsQ, byKindQ, byMemberQ, batchesQ, recentQ]);
  return {
    days,
    totals: { sent: n(t?.sent), failed: n(t?.failed), queued: n(t?.queued), received: n(t?.received), replies: n(t?.replies), viaGmail: n(t?.viaGmail) },
    byKind: [...byKind].map((r) => ({ kind: r.kind, sent: n(r.sent), failed: n(r.failed) })),
    byMember: [...byMember].map((r) => ({ userId: r.user_id, name: r.name, sent: n(r.sent), failed: n(r.failed), lastSentAt: r.last_sent_at ? new Date(r.last_sent_at) : null })),
    batches: [...batches].map((b) => ({
      id: b.id as string,
      name: String(b.name),
      byName: String(b.by_name),
      status: String(b.status),
      preparedAt: new Date(b.prepared_at as string),
      approvedAt: b.approved_at ? new Date(b.approved_at as string) : null,
      recipients: n(b.recipients),
      sent: n(b.sent),
      failed: n(b.failed),
      skipped: n(b.skipped),
      queued: n(b.queued),
    })),
    recent: [...recent].map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      direction: r.direction === 'in' ? 'in' : 'out',
      status: String(r.status),
      subject: String(r.subject ?? ''),
      to: (r.to_emails as string[] | null) ?? [],
      from: String(r.from_email ?? ''),
      kind: (r.kind as string | null) ?? null,
      sentVia: (r.sent_via as string | null) ?? null,
      byName: (r.by_name as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      at: new Date(r.created_at as string),
    })),
  };
}
