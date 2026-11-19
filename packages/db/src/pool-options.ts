/**
 * The database pool each server instance opens (PLATFORM-PLAN 1.8). Through Supabase's transaction pooler,
 * so `prepare` stays off. `max` is DB_POOL_MAX (default 5): enough for a page's parallel queries, few enough that
 * instances × max stays under the pooler's client limit. Idle connections close after 20 s so a quiet instance
 * gives its share back; a connection is recycled every 30 minutes; connecting waits at most 10 s.
 *
 * `max_pipeline: 0` (ADR 0094): one statement in flight per connection. Pipelined onto a busy connection,
 * Supavisor's transaction mode loses some replies and the page hangs (the admin home). Needs the postgres.js
 * patch in patches/, which keeps `sql.begin` reserving its connection.
 */
const DEFAULT_MAX = 5;

export function poolOptions(env: Record<string, string | undefined> = process.env) {
  const raw = env.DB_POOL_MAX?.trim() ?? '';
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const max = n >= 1 && n <= 50 ? n : DEFAULT_MAX;
  return { prepare: false, max, max_pipeline: 0, idle_timeout: 20, connect_timeout: 10, max_lifetime: 1800 } as const;
}
