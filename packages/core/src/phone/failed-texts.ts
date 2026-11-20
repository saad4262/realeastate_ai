import { sql } from 'drizzle-orm';
import { notification, type Db } from '@repo/db';
import type { ReminderDeps } from '../appointments/reminders';
import { buildTextsFailedEmail } from '../email/team-notices';
import { SENDS_PAUSED_REASON } from '../safety/spikes';
import { textsPathFor } from './setup';

export const NOTIFICATION_KIND_TEXTS_FAILED = 'texts_failed';
/** Failures this recent are told; the tick runs every few minutes, so each one is seen. */
const WINDOW_MINUTES = 10;

export type FailedTextsReport = { agents: number; notified: number; emailed: number; failed: number };

/**
 * PLATFORM-PLAN 3.5: when Twilio is down (or refuses the saved key), the agent hears about it by bell and email
 * instead of finding out from an unhappy buyer. A text "Twilio did not take" is one we marked failed with no
 * Twilio SID: the send threw, or the stuck-text check (3.9) found Twilio never had it. A delivery failure Twilio
 * reported (it has a SID) and a text held by paused sends are not this. One bell and one email per agent an hour,
 * whichever path the texts came from (missed-call text, batch, workflow, reconcile). Network after the insert,
 * never inside a transaction.
 */
// shortcut: a scan of sms_message's recent rows every 5 minutes, no index for it; add a partial index on updated_at
// where status = 'failed' and provider_sid is null once sms_message passes ~1M rows (or the tick shows it slow).
export async function tellAgentsOfFailedTexts(db: Db, now: Date, deps: { notice?: ReminderDeps['notice'] }): Promise<FailedTextsReport> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000).toISOString();
  const rows = await db.execute<{ user_id: string; agency_id: string; email: string; role: string | null; n: number; reason: string }>(sql`
    select pn.user_id, pn.agency_id, u.email, m.role, count(*)::int as n, max(s.error) as reason
    from sms_message s
    join phone_number pn on pn.id = s.phone_number_id
    join "user" u on u.id = pn.user_id
    join membership m on m.user_id = pn.user_id and m.agency_id = pn.agency_id and m.status = 'active'
    where s.direction = 'out' and s.status = 'failed' and s.provider_sid is null
      and s.error is distinct from ${SENDS_PAUSED_REASON}
      and s.updated_at > ${since}::timestamptz
    group by 1, 2, 3, 4`);
  const report: FailedTextsReport = { agents: rows.length, notified: 0, emailed: 0, failed: 0 };
  const hour = Math.floor(now.getTime() / 3_600_000);
  for (const r of rows) {
    const reason = (r.reason || 'Twilio did not take them.').slice(0, 300);
    const title = r.n === 1 ? 'A text from your number was not sent' : `${r.n} texts from your number were not sent`;
    const href = textsPathFor(r.role);
    const [told] = await db
      .insert(notification)
      .values({ userId: r.user_id, agencyId: r.agency_id, kind: NOTIFICATION_KIND_TEXTS_FAILED, title, body: `Twilio did not take them: ${reason}`, href, dedupeKey: `${NOTIFICATION_KIND_TEXTS_FAILED}:${hour}` })
      .onConflictDoNothing()
      .returning({ id: notification.id });
    if (!told) continue;
    report.notified += 1;
    if (!deps.notice) continue;
    const n = deps.notice;
    const base = href.startsWith('/my-') ? n.urls.agentUrl : n.urls.agencyUrl;
    try {
      const sent = await n.mailer.transport.send(
        buildTextsFailedEmail({ to: { email: r.email }, from: n.mailer.sender.from, postalAddress: n.mailer.sender.postalAddress, count: r.n, reason, textsUrl: `${base}${href}` }),
      );
      if (sent.ok) report.emailed += 1;
      else report.failed += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
