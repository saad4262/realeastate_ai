import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { PlatformError } from './admin';

/**
 * The admin home's two panels (ADR 0051): what needs the platform team's
 * attention, and leads per week across the platform. `platform:read` only;
 * three statements, started together.
 */

export type PlatformAttention = {
  trialsEnding: { agencyId: string; name: string; trialEndsAt: Date }[];
  suspended: { agencyId: string; name: string; since: Date | null; reason: string | null }[];
  failedMail: { agencyId: string; name: string; failed: number }[];
  blockedMembers: number;
};

export type WeeklyLeads = { weekStart: Date; leads: number }[];

const n = (v: unknown) => Number(v ?? 0);

export async function platformAttention(db: Db, admin: Actor): Promise<{ attention: PlatformAttention; weeklyLeads: WeeklyLeads }> {
  if (!can(admin, 'platform:read', { type: 'platform' })) {
    throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  }
  const [agencies, failed, weeks] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select a.id, a.name, a.status, a.trial_ends_at, a.suspended_at, a.suspended_reason
      from agency a
      where a.status = 'suspended' or (a.status = 'trial' and a.trial_ends_at is not null and a.trial_ends_at < now() + interval '14 days')
      order by a.trial_ends_at nulls last, a.suspended_at desc`),
    db.execute<Record<string, unknown>>(sql`
      select a.id, a.name, count(*)::int as failed
      from mail_message m join agency a on a.id = m.agency_id
      where m.direction = 'out' and m.status = 'failed' and m.created_at > now() - interval '24 hours'
      group by a.id, a.name order by 3 desc limit 10`),
    db.execute<Record<string, unknown>>(sql`
      select w.week_start, (select count(*)::int from lead l where l.created_at >= w.week_start and l.created_at < w.week_start + interval '7 days') as leads,
        -- Platform-blocked members (ADR 0050), carried on every week row: one figure, no extra statement.
        (select count(*)::int from membership m where m.status = 'suspended' and m.removed_at is null) as blocked
      from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') as w(week_start)
      order by w.week_start`),
  ]);
  const rows = [...agencies];
  return {
    attention: {
      trialsEnding: rows
        .filter((r) => r.status === 'trial')
        .map((r) => ({ agencyId: r.id as string, name: String(r.name), trialEndsAt: new Date(r.trial_ends_at as string) })),
      suspended: rows
        .filter((r) => r.status === 'suspended')
        .map((r) => ({ agencyId: r.id as string, name: String(r.name), since: r.suspended_at ? new Date(r.suspended_at as string) : null, reason: (r.suspended_reason as string | null) ?? null })),
      failedMail: [...failed].map((r) => ({ agencyId: r.id as string, name: String(r.name), failed: n(r.failed) })),
      blockedMembers: n([...weeks][0]?.blocked),
    },
    weeklyLeads: [...weeks].map((r) => ({ weekStart: new Date(r.week_start as string), leads: n(r.leads) })),
  };
}
