import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import journal from '@repo/db/journal';

/**
 * `/api/health` (PLATFORM-PLAN 1.14, 1.25): can this deployment reach its database, and has that database had
 * every migration this build expects? Public for uptime monitors, so it answers flags only: no versions, hosts,
 * counts or error text. The scheduler's liveness is watched separately, by its own healthchecks.io ping.
 */
export type Health = {
  status: 'ok' | 'degraded';
  checks: { database: 'ok' | 'down'; schema: 'ok' | 'behind' | 'unknown' };
};

/** The newest migration in this build, from drizzle's journal. */
export const BUILD_MIGRATIONS = { count: journal.entries.length, lastWhen: journal.entries[journal.entries.length - 1]?.when ?? 0 };

export async function healthReport(db: DbOrTx, expected = BUILD_MIGRATIONS): Promise<Health> {
  try {
    const [row] = await db.execute<{ n: number | string; last: number | string | null }>(
      sql`select count(*)::int as n, max(created_at) as last from drizzle.__drizzle_migrations`,
    );
    // Behind = this code expects a migration the database has not had. Ahead is fine: migrations go first.
    const behind = Number(row?.n ?? 0) < expected.count || Number(row?.last ?? 0) < expected.lastWhen;
    const schema = behind ? 'behind' : 'ok';
    return { status: schema === 'ok' ? 'ok' : 'degraded', checks: { database: 'ok', schema } };
  } catch {
    return { status: 'degraded', checks: { database: 'down', schema: 'unknown' } };
  }
}

/**
 * The scheduler's dead-man ping (PLATFORM-PLAN 1.14, 1.23): healthchecks.io alerts when it stops arriving.
 * Never throws and never waits more than 5 s; no URL configured, nothing is sent.
 */
export async function pingHeartbeat(url: string | undefined, outcome: 'ok' | 'fail', fetchImpl: typeof fetch = fetch): Promise<void> {
  const base = url?.trim();
  if (!base) return;
  await fetchImpl(outcome === 'ok' ? base : `${base.replace(/\/+$/, '')}/fail`, { method: 'POST', signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
}
