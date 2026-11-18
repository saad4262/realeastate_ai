import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { agency, notification, type Db } from '@repo/db';
import { agencyNotificationRecipients } from '../agency/notification-recipients';
import type { ReminderDeps } from '../appointments/reminders';
import { recordAudit } from '../audit';
import { buildSendsPausedEmail } from '../email/team-notices';
import { can, type Actor } from '../permissions';

/**
 * Unattended safety (PLATFORM-PLAN 3.7). Every five minutes the tick compares each agency's last hour — texts sent,
 * bulk emails sent, AI spend — with its own usual hour over the week before. Far above both its usual and a floor,
 * the agency's outbound sends are paused (SENDS_HELD_AGENCY_IDS holds them; nothing is lost), its owners and admins
 * are told in the app and by email, and the pause is audited. An owner or admin resumes. Other agencies never notice.
 */
export const SENDS_PAUSED_REASON = "Not sent: this agency's sends are paused. An owner or admin can resume them.";
export const NOTIFICATION_KIND_SENDS_PAUSED = 'sends_paused';

export type SpikeCaps = { multiplier: number; sms: number; email: number; aiUsd: number };

const num = (raw: string | undefined, fallback: number) => {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** From env, with defaults: 3x usual, and at least 60 texts, 300 emails or $5 of AI in the hour. */
export function spikeCaps(env: NodeJS.ProcessEnv = process.env): SpikeCaps {
  return {
    multiplier: num(env.SPIKE_MULTIPLIER, 3),
    sms: num(env.SPIKE_FLOOR_SMS_PER_HOUR, 60),
    email: num(env.SPIKE_FLOOR_EMAIL_PER_HOUR, 300),
    aiUsd: num(env.SPIKE_FLOOR_AI_USD_PER_HOUR, 5),
  };
}

/** An hour is a spike when it is at least the floor AND more than `multiplier` times the usual hour of the 7 days before. */
export function isSpike(lastHour: number, weekBefore: number, floor: number, multiplier: number): boolean {
  const usualHour = weekBefore / (7 * 24 - 1);
  return lastHour >= floor && lastHour > multiplier * usualHour;
}

type Activity = { agency_id: string; sms_hour: number; sms_week: number; email_hour: number; email_week: number; ai_hour: number; ai_week: number };

export type SpikeReport = { checked: number; paused: number; notified: number; emailed: number; failed: number };

export async function detectSendSpikes(db: Db, now: Date, deps: { notice?: ReminderDeps['notice']; env?: NodeJS.ProcessEnv } = {}): Promise<SpikeReport> {
  const caps = spikeCaps(deps.env);
  const hour = new Date(now.getTime() - 3_600_000).toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await db.execute<Activity>(sql`
    with sms as (
      select agency_id, count(*) filter (where created_at >= ${hour}::timestamptz)::int as hour, count(*) filter (where created_at < ${hour}::timestamptz)::int as week
      from sms_message where direction = 'out' and created_at >= ${week}::timestamptz group by agency_id
    ), mail as (
      select b.agency_id, count(*) filter (where r.sent_at >= ${hour}::timestamptz)::int as hour, count(*) filter (where r.sent_at < ${hour}::timestamptz)::int as week
      from email_batch_recipient r join email_batch b on b.id = r.batch_id
      where r.sent_at >= ${week}::timestamptz group by b.agency_id
    ), ai as (
      select agency_id, coalesce(sum(cost_usd) filter (where created_at >= ${hour}::timestamptz), 0)::float as hour,
             coalesce(sum(cost_usd) filter (where created_at < ${hour}::timestamptz), 0)::float as week
      from ai_run where agency_id is not null and created_at >= ${week}::timestamptz group by agency_id
    )
    select a.id as agency_id,
      coalesce(sms.hour, 0) as sms_hour, coalesce(sms.week, 0) as sms_week,
      coalesce(mail.hour, 0) as email_hour, coalesce(mail.week, 0) as email_week,
      coalesce(ai.hour, 0) as ai_hour, coalesce(ai.week, 0) as ai_week
    from agency a
    left join sms on sms.agency_id = a.id left join mail on mail.agency_id = a.id left join ai on ai.agency_id = a.id
    where a.sends_paused_at is null and a.status <> 'suspended'
      and (coalesce(sms.hour, 0) > 0 or coalesce(mail.hour, 0) > 0 or coalesce(ai.hour, 0) > 0)`);

  const report: SpikeReport = { checked: rows.length, paused: 0, notified: 0, emailed: 0, failed: 0 };
  for (const r of rows) {
    const why: string[] = [];
    if (isSpike(Number(r.sms_hour), Number(r.sms_week), caps.sms, caps.multiplier)) why.push(`${r.sms_hour} texts in the last hour`);
    if (isSpike(Number(r.email_hour), Number(r.email_week), caps.email, caps.multiplier)) why.push(`${r.email_hour} emails in the last hour`);
    if (isSpike(Number(r.ai_hour), Number(r.ai_week), caps.aiUsd, caps.multiplier)) why.push(`US$${Number(r.ai_hour).toFixed(2)} of AI in the last hour`);
    if (!why.length) continue;
    const reason = `Far above this agency's usual: ${why.join(', ')}.`;
    const pausedAt = await pauseSends(db, r.agency_id, reason, now, { sms: [r.sms_hour, r.sms_week], email: [r.email_hour, r.email_week], aiUsd: [r.ai_hour, r.ai_week] });
    if (!pausedAt) continue;
    report.paused += 1;
    const told = await tellOwners(db, r.agency_id, reason, pausedAt, deps.notice ?? null);
    report.notified += told.notified;
    report.emailed += told.emailed;
    report.failed += told.failed;
  }
  return report;
}

/** Pause once: a second spike while paused changes nothing. Returns the pause time, or null if it was already paused. */
async function pauseSends(db: Db, agencyId: string, reason: string, now: Date, figures: Record<string, unknown>): Promise<Date | null> {
  return db.transaction(async (tx) => {
    const [done] = await tx
      .update(agency)
      .set({ sendsPausedAt: now, sendsPausedReason: reason, updatedAt: sql`now()` })
      .where(and(eq(agency.id, agencyId), isNull(agency.sendsPausedAt)))
      .returning({ id: agency.id });
    if (!done) return null;
    await recordAudit(tx, { agencyId, actorUserId: null, action: 'sends_paused', detail: { reason, figures } });
    return now;
  });
}

/** A bell for each owner and admin, then an email to whoever got the bell now (never twice for one pause). */
async function tellOwners(db: Db, agencyId: string, reason: string, pausedAt: Date, notice: ReminderDeps['notice'] | null) {
  const people = await agencyNotificationRecipients(db, agencyId);
  const out = { notified: 0, emailed: 0, failed: 0 };
  if (!people.length) return out;
  const title = 'Sends paused: unusual activity';
  const body = `${reason} Texts, bulk email and AI call-backs are on hold until an owner or admin resumes them.`;
  const inserted = await db
    .insert(notification)
    .values(people.map((p) => ({ userId: p.userId, agencyId, kind: NOTIFICATION_KIND_SENDS_PAUSED, title, body, href: '/settings', dedupeKey: `${NOTIFICATION_KIND_SENDS_PAUSED}:${agencyId}:${pausedAt.getTime()}` })))
    .onConflictDoNothing()
    .returning({ userId: notification.userId });
  out.notified = inserted.length;
  if (!notice) return out;
  // Network after the commit, never inside a transaction.
  for (const p of people) {
    if (!inserted.some((i) => i.userId === p.userId)) continue;
    try {
      const sent = await notice.mailer.transport.send(
        buildSendsPausedEmail({ to: { email: p.email }, from: notice.mailer.sender.from, postalAddress: notice.mailer.sender.postalAddress, reason, settingsUrl: `${notice.urls.agencyUrl}/settings` }),
      );
      if (sent.ok) out.emailed += 1;
      else out.failed += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

/** An owner or admin resumes the agency's sends. Returns false when they were not paused. Audited. */
export async function resumeAgencySends(db: Db, actor: Actor): Promise<boolean> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'sends:resume', { type: 'agency', agencyId })) throw new Error('Only an owner or admin may resume sends');
  return db.transaction(async (tx) => {
    const [done] = await tx
      .update(agency)
      .set({ sendsPausedAt: null, sendsPausedReason: null, updatedAt: sql`now()` })
      .where(and(eq(agency.id, agencyId), isNotNull(agency.sendsPausedAt)))
      .returning({ id: agency.id });
    if (done) await recordAudit(tx, { agencyId, actorUserId: actor.userId, action: 'sends_resumed' });
    return !!done;
  });
}
