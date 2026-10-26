import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { membership, notification, opportunity, type Db } from '@repo/db';
import { isAgencyAdminRole, type MembershipRole } from '../permissions';
import { DETECTORS, OPPORTUNITY_KINDS, type Detected, type OpportunityKind } from './detectors';
import { describeOpportunity } from './describe';

/**
 * The hourly opportunity scan (ADR 0054 §4), run by /api/cron/opportunities. It claims nothing:
 * every detector is a read, every write is `on conflict do nothing` on (agency, dedupe_key), so
 * two runs at once, a retry or a manual curl can only find what is already there.
 *
 *   1. expire open opportunities older than 30 days;
 *   2. run every detector (one failing does not stop the others);
 *   3. drop what is already recorded, keep at most MAX_NEW_PER_USER new per person (in KIND_ORDER);
 *   4. insert them and, in the same transaction, one bell notification per person.
 */

export const EXPIRE_AFTER_DAYS = 30;
export const MAX_NEW_PER_USER = 10;
/** Most time-critical first, when a person's cap is reached. */
export const KIND_ORDER: readonly OpportunityKind[] = ['unanswered_mail', 'buyer_match', 'appraisal_follow_up', 'repeat_interest', 'sale_anniversary', 'cold_contact'];

export type OpportunityScanReport = {
  expired: number;
  found: number;
  created: number;
  notified: number;
  failed: OpportunityKind[];
};

/** Step 3 on its own, so it is testable without a database: the new ones, capped per person, in order. */
export function pickNew(detected: Detected[], known: ReadonlySet<string>, cap = MAX_NEW_PER_USER): Detected[] {
  const rank = (k: OpportunityKind) => KIND_ORDER.indexOf(k);
  const seen = new Set<string>();
  const perUser = new Map<string, number>();
  const out: Detected[] = [];
  for (const d of [...detected].sort((a, b) => rank(a.kind) - rank(b.kind))) {
    const key = `${d.agencyId}|${d.dedupeKey}`;
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    const n = perUser.get(d.userId) ?? 0;
    if (n >= cap) continue;
    perUser.set(d.userId, n + 1);
    out.push(d);
  }
  return out;
}

/** Where the bell sends a person: their own assistant home. */
export function opportunitiesHref(role: MembershipRole | null | undefined): string {
  return isAgencyAdminRole(role) ? '/overview#opportunities' : '/assistant#opportunities';
}

export async function runOpportunityScan(db: Db, opts: { now?: Date } = {}): Promise<OpportunityScanReport> {
  const now = opts.now ?? new Date();
  const expired = await db
    .update(opportunity)
    .set({ status: 'expired', resolvedAt: sql`now()` })
    .where(and(eq(opportunity.status, 'open'), lt(opportunity.createdAt, new Date(now.getTime() - EXPIRE_AFTER_DAYS * 86_400_000))))
    .returning({ id: opportunity.id });

  const report: OpportunityScanReport = { expired: expired.length, found: 0, created: 0, notified: 0, failed: [] };
  const detected: Detected[] = [];
  for (const kind of OPPORTUNITY_KINDS) {
    try {
      detected.push(...(await DETECTORS[kind](db)));
    } catch (err) {
      console.error('[opportunities] detector failed', kind, err instanceof Error ? err.message : err);
      report.failed.push(kind);
    }
  }
  report.found = detected.length;
  if (!detected.length) return report;

  // What is already recorded (open, done, dismissed or expired): one statement for all of them.
  // The candidates as ONE json parameter: Drizzle spreads a JS array into a record `($1, $2…)`, never an array.
  const candidates = JSON.stringify(detected.map((d) => ({ agency_id: d.agencyId, dedupe_key: d.dedupeKey })));
  const existing = await db.execute<{ agency_id: string; dedupe_key: string }>(sql`
    select o.agency_id, o.dedupe_key from opportunity o
    join jsonb_to_recordset(${candidates}::jsonb) as c(agency_id uuid, dedupe_key text)
      on c.agency_id = o.agency_id and c.dedupe_key = o.dedupe_key`);
  const known = new Set(existing.map((e) => `${e.agency_id}|${e.dedupe_key}`));
  const fresh = pickNew(detected, known);
  if (!fresh.length) return report;

  const users = [...new Set(fresh.map((d) => d.userId))];
  const roles = await db
    .select({ userId: membership.userId, agencyId: membership.agencyId, role: membership.role })
    .from(membership)
    .where(and(inArray(membership.userId, users), eq(membership.status, 'active')));
  const roleOf = new Map(roles.map((r) => [`${r.userId}|${r.agencyId}`, r.role as MembershipRole]));
  // One notification per person per scan: the hour names the scan.
  const stamp = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(opportunity)
      .values(
        fresh.map((d) => ({
          agencyId: d.agencyId,
          userId: d.userId,
          kind: d.kind,
          contactId: d.contactId,
          listingId: d.listingId,
          leadId: d.leadId,
          threadId: d.threadId,
          appointmentId: d.appointmentId,
          facts: d.facts,
          dedupeKey: d.dedupeKey,
        })),
      )
      .onConflictDoNothing({ target: [opportunity.agencyId, opportunity.dedupeKey] })
      .returning({ userId: opportunity.userId, agencyId: opportunity.agencyId, kind: opportunity.kind, facts: opportunity.facts });
    report.created = inserted.length;

    const byUser = new Map<string, typeof inserted>();
    for (const o of inserted) byUser.set(`${o.userId}|${o.agencyId}`, [...(byUser.get(`${o.userId}|${o.agencyId}`) ?? []), o]);
    if (!byUser.size) return;
    const notes = [...byUser.entries()].map(([key, list]) => {
      const [userId, agencyId] = key.split('|') as [string, string];
      const titles = list.map((o) => describeOpportunity(o.kind, o.facts as Record<string, unknown>).title);
      return {
        userId,
        agencyId,
        kind: 'opportunities',
        title: list.length === 1 ? titles[0]! : `${list.length} new opportunities`,
        body: list.length === 1 ? 'The assistant noticed something you may want to act on.' : titles.slice(0, 3).join(' · ') + (list.length > 3 ? ' …' : ''),
        href: opportunitiesHref(roleOf.get(key)),
        dedupeKey: `opportunities:${stamp}`,
      };
    });
    const told = await tx.insert(notification).values(notes).onConflictDoNothing({ target: [notification.userId, notification.dedupeKey] }).returning({ id: notification.id });
    report.notified = told.length;
  });
  return report;
}
