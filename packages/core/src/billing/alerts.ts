import { sql } from 'drizzle-orm';
import { notification, type Db } from '@repo/db';
import { agencyNotificationRecipients } from '../agency/notification-recipients';
import type { ReminderDeps } from '../appointments/reminders';
import { buildCreditUsageEmail } from '../email/team-notices';
import { PAID_PLANS } from './plans';

/**
 * PLATFORM-PLAN 2.6: a paid agency's owners hear when its AI credits reach 80% and 100% — a bell and an email,
 * once per level per set of grants. The key carries the newest active grant, so a top-up or a new period starts
 * the count again; the same period never alerts twice. Owners only: buying more is `billing:manage`.
 */
export const NOTIFICATION_KIND_CREDITS = 'credits_used';

/** 100 when nothing is left, 80 from four fifths, else null. */
export function creditLevel(credits: number, used: number): 80 | 100 | null {
  if (credits <= 0) return null;
  if (used >= credits) return 100;
  return used >= 0.8 * credits ? 80 : null;
}

type Usage = { agency_id: string; credits: string; used: string; newest: string };
export type CreditAlertReport = { agencies: number; notified: number; emailed: number; failed: number };

export async function creditUsageAlerts(db: Db, now: Date, deps: { notice?: ReminderDeps['notice'] | null } = {}): Promise<CreditAlertReport> {
  const at = now.toISOString();
  const plans = sql.join(PAID_PLANS.map((p) => sql`${p}`), sql`, `);
  const rows = await db.execute<Usage>(sql`
    select g.agency_id, sum(g.credits) as credits, sum(g.used) as used,
      (array_agg(g.id order by g.created_at desc, g.id desc))[1] as newest
    from ai_credit_grant g join agency a on a.id = g.agency_id
    where a.plan in (${plans}) and g.valid_from <= ${at}::timestamptz and g.expires_at > ${at}::timestamptz
    group by g.agency_id
    having sum(g.used) >= 0.8 * sum(g.credits) and sum(g.credits) > 0`);

  const report: CreditAlertReport = { agencies: 0, notified: 0, emailed: 0, failed: 0 };
  for (const r of rows) {
    const credits = Number(r.credits);
    const used = Number(r.used);
    const level = creditLevel(credits, used);
    if (!level) continue;
    report.agencies += 1;
    const owners = await agencyNotificationRecipients(db, r.agency_id, ['owner']);
    if (!owners.length) continue;
    const left = Math.max(0, Math.floor(credits - used));
    const title = level === 100 ? 'AI credits used up' : 'AI credits 80% used';
    const body =
      level === 100
        ? 'AI features are paused until your next billing period or a top-up.'
        : `${left} of ${credits} credits left this period. AI features pause at 100%.`;
    const inserted = await db
      .insert(notification)
      .values(owners.map((o) => ({ userId: o.userId, agencyId: r.agency_id, kind: NOTIFICATION_KIND_CREDITS, title, body, href: '/settings', dedupeKey: `credits_${level}:${r.agency_id}:${r.newest}` })))
      .onConflictDoNothing()
      .returning({ userId: notification.userId });
    report.notified += inserted.length;
    const notice = deps.notice;
    if (!notice) continue;
    // The bell row is the once-only guard; an email that fails is counted, not retried (the bell still shows).
    for (const o of owners) {
      if (!inserted.some((i) => i.userId === o.userId)) continue;
      try {
        const sent = await notice.mailer.transport.send(
          buildCreditUsageEmail({ to: { email: o.email }, from: notice.mailer.sender.from, postalAddress: notice.mailer.sender.postalAddress, level, credits, left, settingsUrl: `${notice.urls.agencyUrl}/settings` }),
        );
        if (sent.ok) report.emailed += 1;
        else report.failed += 1;
      } catch {
        report.failed += 1;
      }
    }
  }
  return report;
}
