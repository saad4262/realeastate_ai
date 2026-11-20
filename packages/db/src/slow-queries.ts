import { config } from 'dotenv';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { assertNotProduction } from './production-guard';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * PLATFORM-PLAN 1.11: the weekly look at the slowest statements. Prints the top 10 by total time from
 * pg_stat_statements (since its last reset), each with Supabase's index advisor's suggestion, as a Markdown table
 * to paste into docs/SESSION.md. Read-only.
 *
 *   pnpm --filter @repo/db db:slow-queries        (DIRECT_URL; production needs CONFIRM_PRODUCTION)
 */
type Row = { calls: string; total_ms: string; mean_ms: string; pct: string; query: string };

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL is not set');
  assertNotProduction(url);
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const rows = await sql<Row[]>`
      select s.calls::text, round(s.total_exec_time)::text as total_ms, round(s.mean_exec_time::numeric, 1)::text as mean_ms,
        round((100 * s.total_exec_time / nullif(sum(s.total_exec_time) over (), 0))::numeric, 1)::text as pct, s.query
      from extensions.pg_stat_statements s
      where s.dbid = (select oid from pg_database where datname = current_database())
        and s.userid = (select oid from pg_roles where rolname = 'postgres') -- the app's role, not Supabase's own services
        and s.query !~* '^\\s*(begin|commit|rollback|set|show|deallocate)\\b'
      order by s.total_exec_time desc limit 10`;
    const since = (await sql<{ at: string | null }[]>`select stats_reset::text as at from extensions.pg_stat_statements_info`)[0]?.at;
    console.log(`Top 10 statements by total time since ${since ?? 'the stats were last reset'}\n`);
    console.log('| # | calls | total ms | mean ms | % | statement | index advisor |\n|---|---|---|---|---|---|---|');
    for (const [i, r] of rows.entries()) {
      let advice = '—';
      if (/^\s*(select|with)\b/i.test(r.query)) {
        try {
          const [a] = await sql<{ index_statements: string[]; errors: string[] }[]>`select index_statements, errors from extensions.index_advisor(${r.query})`;
          advice = a?.index_statements?.length ? a.index_statements.join('; ') : a?.errors?.length ? `(${a.errors.join('; ').slice(0, 80)})` : 'none';
        } catch (err) {
          advice = `(advisor: ${(err as Error).message.slice(0, 60)})`;
        }
      }
      const q = r.query.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 160);
      console.log(`| ${i + 1} | ${r.calls} | ${r.total_ms} | ${r.mean_ms} | ${r.pct} | \`${q}\` | ${advice} |`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
