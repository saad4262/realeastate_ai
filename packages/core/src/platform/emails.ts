import { sql } from 'drizzle-orm';
import { platformEmail, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { escapeHtml, requireSenderFooter } from '../email/schedule-digest';
import type { SenderIdentity } from '../email/resend-transport';
import type { EmailTransport } from '../email/transport';
import { PlatformError } from './admin';

/**
 * Email from the platform team (ADR 0052): to one agency's owners and admins,
 * one member, one site user, or a whole audience.
 *
 * The recipients are worked out HERE from the database — never sent by the
 * browser — and frozen as `platform_email_recipient` rows in the same
 * transaction as the email. Delivery is separate (`deliverPlatformEmails`):
 * the console sends a first batch straight away, the cron tick the rest, and
 * a network call never runs inside a transaction.
 *
 * These are service messages from the platform to its own account holders
 * (`transactional`, no unsubscribe link). A promotion is a commercial message
 * under the Spam Act and needs consent and an unsubscribe — the compose screen
 * says so; this code cannot tell the difference.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const n = (v: unknown) => Number(v ?? 0);

export type EmailAudience =
  | { kind: 'agency'; agencyId: string }
  | { kind: 'member'; agencyId: string; userId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'all_agencies' }
  | { kind: 'all_agents' }
  | { kind: 'all_users' };

export const AUDIENCE_LABEL: Record<EmailAudience['kind'], string> = {
  agency: "this agency's owners and admins",
  member: 'this member',
  user: 'this user',
  all_agencies: 'the owners and admins of every agency (suspended ones left out)',
  all_agents: 'every active member of every agency (suspended agencies left out)',
  all_users: 'every public-site user (blocked ones left out)',
};

function requireManager(admin: Actor): void {
  if (!can(admin, 'platform:manage', { type: 'platform' })) {
    throw new PlatformError('forbidden', 'Only a platform admin may send this');
  }
}

/** The recipients of an audience, one row per address: user_id, email, name. A sub-select for insert or count. */
function recipientsSql(a: EmailAudience) {
  const person = sql.raw(`u.id as user_id, u.email, coalesce(nullif(u.name, ''), u.email) as name`);
  const siteUser = sql.raw(
    `not exists (select 1 from membership m2 where m2.user_id = u.id) and not exists (select 1 from platform_admin pa where pa.user_id = u.id)`,
  );
  let inner;
  switch (a.kind) {
    case 'agency':
      inner = sql`select ${person} from membership m join "user" u on u.id = m.user_id
        where m.agency_id = ${a.agencyId} and m.status = 'active' and m.role in ('owner', 'admin')`;
      break;
    case 'member':
      inner = sql`select ${person} from membership m join "user" u on u.id = m.user_id
        where m.agency_id = ${a.agencyId} and m.user_id = ${a.userId}`;
      break;
    case 'user':
      inner = sql`select ${person} from "user" u where u.id = ${a.userId} and ${siteUser}`;
      break;
    case 'all_agencies':
      inner = sql`select ${person} from membership m join "user" u on u.id = m.user_id join agency ag on ag.id = m.agency_id
        where m.status = 'active' and m.role in ('owner', 'admin') and ag.status <> 'suspended'`;
      break;
    case 'all_agents':
      inner = sql`select ${person} from membership m join "user" u on u.id = m.user_id join agency ag on ag.id = m.agency_id
        where m.status = 'active' and ag.status <> 'suspended'`;
      break;
    case 'all_users':
      inner = sql`select ${person} from "user" u where ${siteUser} and u.blocked_at is null`;
      break;
  }
  // One email per address, whatever the audience joins.
  return sql`select distinct on (lower(x.email)) x.user_id, x.email, x.name from (${inner}) x where x.email like '%@%' order by lower(x.email), x.user_id`;
}

function checkAudience(a: EmailAudience): void {
  const ids = [
    'agencyId' in a ? a.agencyId : null,
    'userId' in a ? a.userId : null,
  ].filter((v): v is string => v !== null);
  if (!(a.kind in AUDIENCE_LABEL) || ids.some((id) => !UUID.test(id))) {
    throw new PlatformError('invalid', 'Choose who to write to.');
  }
}

/** How many people an audience reaches, and the first few names — for the confirm step. One statement. */
export async function previewPlatformEmail(db: Db, admin: Actor, audience: EmailAudience): Promise<{ count: number; sample: string[] }> {
  requireManager(admin);
  checkAudience(audience);
  const rows = await db.execute<{ name: string; total: number }>(sql`
    select r.name, count(*) over()::int as total from (${recipientsSql(audience)}) r order by r.name limit 5`);
  return { count: n(rows[0]?.total), sample: [...rows].map((r) => String(r.name)) };
}

export type PlatformEmailInput = { subject: string; body: string };

/**
 * Record an email and freeze its recipients. Nothing is sent here. Three
 * statements in one transaction. Refused when the audience reaches nobody.
 */
export async function createPlatformEmail(
  db: Db,
  admin: Actor,
  audience: EmailAudience,
  input: PlatformEmailInput,
): Promise<{ emailId: string; recipients: number }> {
  requireManager(admin);
  checkAudience(audience);
  const subject = input.subject.trim().replace(/\s+/g, ' ');
  const body = input.body.trim();
  if (subject.length < 3 || subject.length > 200) throw new PlatformError('invalid', 'Write a subject (3 to 200 characters).');
  if (body.length < 10 || body.length > 20_000) throw new PlatformError('invalid', 'Write the message (at least a sentence).');

  return db.transaction(async (tx) => {
    const [email] = await tx
      .insert(platformEmail)
      .values({
        adminUserId: admin.userId,
        audience: audience.kind,
        agencyId: 'agencyId' in audience ? audience.agencyId : null,
        subjectUserId: 'userId' in audience ? audience.userId : null,
        subject,
        body,
      })
      .returning({ id: platformEmail.id });
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into platform_email_recipient (email_id, user_id, email, name)
      select ${email!.id}, r.user_id, r.email, r.name from (${recipientsSql(audience)}) r
      returning id`);
    const count = [...inserted].length;
    if (count === 0) throw new PlatformError('invalid', 'Nobody to send to — the audience is empty.');
    await tx.execute(sql`update platform_email set recipients = ${count} where id = ${email!.id}`);
    return { emailId: email!.id, recipients: count };
  });
}

export type PlatformMailDeps = { sender: SenderIdentity; transport: EmailTransport };

function renderEmail(sender: SenderIdentity, subject: string, body: string, name: string | null) {
  requireSenderFooter(sender.from, sender.postalAddress, 'platform message');
  const footer = `${sender.from.name} · ${sender.postalAddress}\nYou are receiving this because you have an account on ${sender.from.name}.`;
  const greeting = name ? `Hi ${name},\n\n` : '';
  const text = `${greeting}${body}\n\n—\n${footer}`;
  const paras = `${greeting}${body}`
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b1f24">${paras}<hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:12px;color:#666;margin:0">${escapeHtml(footer).replace(/\n/g, '<br>')}</p></div>`;
  return { text, html };
}

/**
 * Send queued recipients — of one email, or any. Claims a batch (a short
 * statement, `sending` + a timestamp; a claim older than 10 minutes is taken
 * again), sends each outside any transaction, then records the result.
 */
export async function deliverPlatformEmails(
  db: Db,
  deps: PlatformMailDeps | null,
  opts: { emailId?: string; limit?: number } = {},
): Promise<{ sent: number; failed: number }> {
  if (!deps) return { sent: 0, failed: 0 };
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const claimed = await db.execute<{ id: string; email: string; name: string | null; subject: string; body: string; email_id: string }>(sql`
    update platform_email_recipient r set status = 'sending', sent_at = now()
    from platform_email e
    where e.id = r.email_id and r.id in (
      select q.id from platform_email_recipient q
      where (q.status = 'queued' or (q.status = 'sending' and q.sent_at < now() - interval '10 minutes'))
        ${opts.emailId ? sql`and q.email_id = ${opts.emailId}` : sql``}
      order by q.created_at limit ${limit} for update skip locked
    )
    returning r.id, r.email, r.name, e.subject, e.body, e.id as email_id`);
  let sent = 0;
  let failed = 0;
  for (const r of claimed) {
    const { text, html } = renderEmail(deps.sender, r.subject, r.body, r.name);
    const result = await deps.transport
      .send({
        kind: 'transactional',
        to: { email: r.email, ...(r.name ? { name: r.name } : {}) },
        from: deps.sender.from,
        subject: r.subject,
        text,
        html,
        tags: { kind: 'platform_email', email_id: r.email_id },
        idempotencyKey: `platform-email-${r.id}`,
      })
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'send failed' }));
    if (result.ok) {
      sent += 1;
      await db.execute(sql`update platform_email_recipient set status = 'sent', provider_id = ${result.id}, error = null, sent_at = now() where id = ${r.id}`);
    } else {
      failed += 1;
      const error = 'error' in result ? String(result.error).slice(0, 500) : 'send failed';
      await db.execute(sql`update platform_email_recipient set status = 'failed', error = ${error} where id = ${r.id}`);
    }
  }
  return { sent, failed };
}

export type PlatformEmailRow = {
  id: string;
  at: Date;
  adminName: string;
  audience: EmailAudience['kind'];
  targetName: string | null;
  subject: string;
  recipients: number;
  sent: number;
  failed: number;
  queued: number;
};

/** What the platform has emailed, newest first, with delivery counts. One statement. */
export async function listPlatformEmails(db: Db, admin: Actor, opts: { agencyId?: string; userId?: string; limit?: number } = {}): Promise<PlatformEmailRow[]> {
  if (!can(admin, 'platform:read', { type: 'platform' })) throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  const rows = await db.execute<Record<string, unknown>>(sql`
    select e.id, e.created_at, e.audience, e.subject, e.recipients,
      coalesce(nullif(a.name, ''), a.email) as admin_name,
      coalesce(ag.name, (select coalesce(nullif(s.name, ''), s.email) from "user" s where s.id = e.subject_user_id)) as target_name,
      (select count(*)::int from platform_email_recipient r where r.email_id = e.id and r.status = 'sent') as sent,
      (select count(*)::int from platform_email_recipient r where r.email_id = e.id and r.status = 'failed') as failed,
      (select count(*)::int from platform_email_recipient r where r.email_id = e.id and r.status in ('queued', 'sending')) as queued
    from platform_email e join "user" a on a.id = e.admin_user_id left join agency ag on ag.id = e.agency_id
    where true
      ${opts.agencyId && UUID.test(opts.agencyId) ? sql`and e.agency_id = ${opts.agencyId}` : sql``}
      ${opts.userId && UUID.test(opts.userId) ? sql`and e.subject_user_id = ${opts.userId}` : sql``}
    order by e.created_at desc limit ${Math.min(opts.limit ?? 50, 200)}`);
  return [...rows].map((r) => ({
    id: r.id as string,
    at: new Date(r.created_at as string),
    adminName: String(r.admin_name),
    audience: r.audience as EmailAudience['kind'],
    targetName: (r.target_name as string | null) ?? null,
    subject: String(r.subject),
    recipients: n(r.recipients),
    sent: n(r.sent),
    failed: n(r.failed),
    queued: n(r.queued),
  }));
}

/** "Harbour Realty's owners and admins", "Ann Lee (agent at Harbour)", "Bilal" — for the compose screen. One statement. */
export async function describeAudience(db: Db, admin: Actor, audience: EmailAudience): Promise<string | null> {
  if (!can(admin, 'platform:read', { type: 'platform' })) throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  checkAudience(audience);
  if (audience.kind === 'agency') {
    const [r] = await db.execute<{ name: string }>(sql`select name from agency where id = ${audience.agencyId}`);
    return r ? `${r.name} — its owners and admins` : null;
  }
  if (audience.kind === 'member') {
    const [r] = await db.execute<{ name: string; agency: string }>(sql`
      select coalesce(nullif(u.name, ''), u.email) as name, a.name as agency
      from membership m join "user" u on u.id = m.user_id join agency a on a.id = m.agency_id
      where m.agency_id = ${audience.agencyId} and m.user_id = ${audience.userId}`);
    return r ? `${r.name} (${r.agency})` : null;
  }
  if (audience.kind === 'user') {
    const [r] = await db.execute<{ name: string }>(sql`select coalesce(nullif(name, ''), email) as name from "user" where id = ${audience.userId}`);
    return r ? r.name : null;
  }
  return AUDIENCE_LABEL[audience.kind];
}
