import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { SENDS_PAUSED_REASON } from './spikes';

/**
 * PLATFORM-PLAN 3.7: "the agency sees last night's failures in the morning". Owners and admins, on the Overview:
 * what did not go through since 6 pm yesterday on the agency's own clock — texts and emails not sent, bulk email
 * recipients that failed, repeating automations and skill runs that failed, workflow events that ran out of
 * retries. Counts only, each with the page where it can be looked at. Texts held by a pause are not failures.
 * shortcut: sms_message has no index on (agency_id, updated_at); add one if this card shows in the slow-query report.
 */
export type OvernightKind = 'texts' | 'emails' | 'bulkEmails' | 'automations' | 'skills' | 'workflows';
export type OvernightLine = { kind: OvernightKind; count: number; words: string; href: string };
export type Overnight = { since: Date; timeZone: string; lines: OvernightLine[] };

const LINES: { kind: OvernightKind; one: string; many: string; href: string }[] = [
  { kind: 'texts', one: 'text was not sent', many: 'texts were not sent', href: '/inbox/texts' },
  { kind: 'emails', one: 'email was not sent', many: 'emails were not sent', href: '/inbox' },
  { kind: 'bulkEmails', one: 'bulk email recipient was not reached', many: 'bulk email recipients were not reached', href: '/bulk-email' },
  { kind: 'automations', one: 'repeating automation run failed', many: 'repeating automation runs failed', href: '/control-centre' },
  { kind: 'skills', one: 'skill run failed', many: 'skill runs failed', href: '/skills' },
  { kind: 'workflows', one: 'workflow event gave up after its retries', many: 'workflow events gave up after their retries', href: '/skills' },
];

type Row = { since: string | Date; time_zone: string } & Record<'texts' | 'emails' | 'bulk_emails' | 'automations' | 'skills' | 'workflows', number>;
const COLUMN: Record<OvernightKind, keyof Row> = { texts: 'texts', emails: 'emails', bulkEmails: 'bulk_emails', automations: 'automations', skills: 'skills', workflows: 'workflows' };

/** Null for anyone who may not read the agency's reports (agents, assistants); then no query runs. One statement. */
export async function overnightFailures(db: DbOrTx, actor: Actor, now: Date = new Date()): Promise<Overnight | null> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'report:read_agency', { type: 'agency', agencyId })) return null;
  const at = now.toISOString();
  const rows = await db.execute<Row>(sql`
    with a as (
      select id, time_zone,
        (date_trunc('day', ${at}::timestamptz at time zone time_zone) - interval '6 hours') at time zone time_zone as since
      from agency where id = ${agencyId}
    )
    select a.since, a.time_zone,
      (select count(*)::int from sms_message s where s.agency_id = a.id and s.direction = 'out' and s.status = 'failed'
         and s.error is distinct from ${SENDS_PAUSED_REASON} and s.updated_at >= a.since) as texts,
      (select count(*)::int from mail_message m where m.agency_id = a.id and m.direction = 'out' and m.status = 'failed'
         and m.created_at >= a.since) as emails,
      (select count(*)::int from email_batch_recipient r join email_batch b on b.id = r.batch_id
         where b.agency_id = a.id and r.status = 'failed' and b.finished_at >= a.since) as bulk_emails,
      (select count(*)::int from automation_run x where x.agency_id = a.id and x.status = 'failed' and x.finished_at >= a.since) as automations,
      (select count(*)::int from skill_run k where k.agency_id = a.id and k.status = 'failed' and k.finished_at >= a.since) as skills,
      (select count(*)::int from workflow_event e where e.agency_id = a.id and e.failed_at >= a.since) as workflows
    from a`);
  const r = rows[0];
  if (!r) return null;
  return { since: new Date(r.since), timeZone: r.time_zone, lines: overnightLines(r) };
}

/** The non-zero counts in words, in a fixed order. Pure. */
export function overnightLines(r: Partial<Record<keyof Row, unknown>>): OvernightLine[] {
  return LINES.flatMap((l) => {
    const count = Number(r[COLUMN[l.kind]] ?? 0);
    return count > 0 ? [{ kind: l.kind, count, words: `${count} ${count === 1 ? l.one : l.many}`, href: l.href }] : [];
  });
}
