import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import journal from '@repo/db/journal';
import { SENDS_HELD_AGENCY_IDS } from '../platform/access';

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

/**
 * A database that has not answered within `timeoutMs` (2 s) counts as down: a monitor gets its answer at once instead
 * of waiting on a request that may never finish (V1-PERFORMANCE-PLAN step 1).
 */
export async function healthReport(db: DbOrTx, expected = BUILD_MIGRATIONS, timeoutMs = 2_000): Promise<Health> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [row] = await Promise.race([
      db.execute<{ n: number | string; last: number | string | null }>(
        sql`select count(*)::int as n, max(created_at) as last from drizzle.__drizzle_migrations`,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    // Behind = this code expects a migration the database has not had. Ahead is fine: migrations go first.
    const behind = Number(row?.n ?? 0) < expected.count || Number(row?.last ?? 0) < expected.lastWhen;
    const schema = behind ? 'behind' : 'ok';
    return { status: schema === 'ok' ? 'ok' : 'degraded', checks: { database: 'ok', schema } };
  } catch {
    return { status: 'degraded', checks: { database: 'down', schema: 'unknown' } };
  } finally {
    clearTimeout(timer);
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

/**
 * PLATFORM-PLAN 1.23: the alert lines only the database can see, for an uptime monitor that pages a phone.
 * Each is a flag (no counts, no ids, no text), and any one in alert makes the route answer 503:
 * - jobLag: a job due more than 2 minutes ago and not started (held agencies' send jobs and SENDS_PAUSED aside);
 * - deadJobs: a job dead-lettered in the last 24 hours (replay or resolve it in the admin console);
 * - stuckTexts: a text queued without a Twilio id for over 30 minutes (the reconcile check should have settled it);
 * - sendsPaused: an agency's sends paused by the spike check in the last 24 hours.
 * Sentry (errors, p95), Supabase (CPU, pooler) and the backups' healthchecks carry the other lines (O-13, O-14, O-8).
 */
export type AlertLines = { status: 'ok' | 'alert'; lines: Record<'jobLag' | 'deadJobs' | 'stuckTexts' | 'sendsPaused', 'ok' | 'alert'> };

export async function alertLines(db: DbOrTx, env: NodeJS.ProcessEnv = process.env): Promise<AlertLines> {
  const sendsPaused = env.SENDS_PAUSED?.trim() === '1';
  const [r] = await db.execute<{ lag: boolean; dead: boolean; stuck: boolean; paused: boolean }>(sql`
    select
      exists (select 1 from job j where j.status = 'queued' and j.run_at < now() - interval '2 minutes'
        and (j.lane = 'urgent' or (${!sendsPaused} and (j.agency_id is null or j.agency_id not in ${SENDS_HELD_AGENCY_IDS})))) as lag,
      exists (select 1 from job where status = 'dead' and finished_at > now() - interval '24 hours') as dead,
      exists (select 1 from sms_message where direction = 'out' and status = 'queued' and provider_sid is null
        and created_at < now() - interval '30 minutes' and created_at > now() - interval '3 days') as stuck,
      exists (select 1 from agency where sends_paused_at > now() - interval '24 hours') as paused`);
  const flag = (b: boolean | undefined) => (b ? 'alert' : 'ok') as 'ok' | 'alert';
  const lines = { jobLag: flag(r?.lag), deadJobs: flag(r?.dead), stuckTexts: flag(r?.stuck), sendsPaused: flag(r?.paused) };
  return { status: Object.values(lines).includes('alert') ? 'alert' : 'ok', lines };
}
