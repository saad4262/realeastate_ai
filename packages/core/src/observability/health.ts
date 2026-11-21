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

/**
 * PLATFORM-PLAN 1.23: the alert lines only the database can see, for an uptime monitor that pages a phone.
 * Each is a flag (no counts, no ids, no text), and any one in alert makes the route answer 503:
 * - jobLag: a job due more than 2 minutes ago and not started (held agencies' send jobs and SENDS_PAUSED aside);
 * - deadJobs: a job dead-lettered in the last 24 hours (replay or resolve it in the admin console);
 * - stuckTexts: a text queued without a Twilio id for over 30 minutes (the reconcile check should have settled it);
 * - sendsPaused: an agency's sends paused by the spike check in the last 24 hours;
 * - stuckClients: a statement waiting on its client (`active`, `ClientRead`) with its transaction open for over a
 *   minute (V1-PERFORMANCE-PLAN step 9). A client or the pooler stalled mid-statement and holds a connection, and the
 *   locks its transaction took. `idle_in_transaction_session_timeout` (0106) does not end these: the session is
 *   active, not idle. Seen on dev on 2026-11-21, open for up to 1,020 s.
 * Sentry (errors, p95), Supabase (CPU, pooler) and the backups' healthchecks carry the other lines (O-13, O-14, O-8).
 */
export type AlertLines = { status: 'ok' | 'alert'; lines: Record<'jobLag' | 'deadJobs' | 'stuckTexts' | 'sendsPaused' | 'stuckClients', 'ok' | 'alert'> };

export async function alertLines(db: DbOrTx, env: NodeJS.ProcessEnv = process.env, opts: { stuckClientSeconds?: number } = {}): Promise<AlertLines> {
  const sendsPaused = env.SENDS_PAUSED?.trim() === '1';
  const stuckAfter = opts.stuckClientSeconds ?? 60;
  const [r] = await db.execute<{ lag: boolean; dead: boolean; stuck: boolean; paused: boolean; clients: boolean }>(sql`
    select
      exists (select 1 from job j where j.status = 'queued' and j.run_at < now() - interval '2 minutes'
        and (j.lane = 'urgent' or (${!sendsPaused} and (j.agency_id is null or j.agency_id not in ${SENDS_HELD_AGENCY_IDS})))) as lag,
      exists (select 1 from job where status = 'dead' and finished_at > now() - interval '24 hours') as dead,
      exists (select 1 from sms_message where direction = 'out' and status = 'queued' and provider_sid is null
        and created_at < now() - interval '30 minutes' and created_at > now() - interval '3 days') as stuck,
      exists (select 1 from agency where sends_paused_at > now() - interval '24 hours') as paused,
      exists (select 1 from pg_stat_activity a where a.datname = current_database() and a.backend_type = 'client backend'
        and a.pid <> pg_backend_pid() and a.state = 'active' and a.wait_event = 'ClientRead'
        and a.xact_start < now() - make_interval(secs => ${stuckAfter})) as clients`);
  const flag = (b: boolean | undefined) => (b ? 'alert' : 'ok') as 'ok' | 'alert';
  const lines = { jobLag: flag(r?.lag), deadJobs: flag(r?.dead), stuckTexts: flag(r?.stuck), sendsPaused: flag(r?.paused), stuckClients: flag(r?.clients) };
  return { status: Object.values(lines).includes('alert') ? 'alert' : 'ok', lines };
}
