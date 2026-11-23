// PLATFORM-PLAN 4.3: during a run, every 5 s, what the database and the local servers are doing. Started by run.sh.
// node load/sampler.mjs <out.csv>   (stops on SIGTERM). Read-only. Refuses production.
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const postgres = createRequire(new URL('../packages/db/package.json', import.meta.url))('postgres');
const out = process.argv[2];
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!out || !url) throw new Error('usage: node load/sampler.mjs <out.csv> (DIRECT_URL set)');
if (url.includes('xjklpoyxcvnlhjlxasmv')) throw new Error('Refusing: that is the production database');
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0 });

// The local servers by the port they listen on (empty when the target is a preview); k6 by name.
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const pidOn = (port) => sh('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n')[0];
const pids = { web: pidOn(3000), console: pidOn(3001) };
function proc(pid) {
  if (!pid) return ['', ''];
  const [cpu, rss] = sh('ps', ['-o', '%cpu=,rss=', '-p', pid]).split(/\s+/);
  return [cpu ?? '', rss ? Math.round(Number(rss) / 1024) : ''];
}
const k6cpu = () => sh('ps', ['-A', '-o', '%cpu=,comm=']).split('\n').filter((l) => /\bk6$/.test(l)).reduce((s, l) => s + Number(l.trim().split(/\s+/)[0]), 0);

// longest_wait: what the longest running statement waits on (ClientWrite = a client that stopped reading; Lock;
// IO…; empty = on CPU). waits: active backends by wait event, `event:count` joined by `;`.
writeFileSync(out, 't,connections,active,idle,idle_in_tx,waiting_lock,longest_active_s,longest_wait,waits,tps,cache_hit_pct,web_cpu,web_rss_mb,console_cpu,console_rss_mb,k6_cpu\n');
let last = null;
async function sample() {
  const [a] = await sql`select count(*)::int as total,
      count(*) filter (where state = 'active')::int as active,
      count(*) filter (where state = 'idle')::int as idle,
      count(*) filter (where state like 'idle in transaction%')::int as idle_in_tx,
      count(*) filter (where wait_event_type = 'Lock')::int as waiting_lock,
      coalesce(extract(epoch from max(now() - query_start) filter (where state = 'active' and pid <> pg_backend_pid())), 0)::float as longest
    from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()`;
  const [w] = await sql`select
      (select coalesce(wait_event, 'CPU') from pg_stat_activity where backend_type = 'client backend' and state = 'active'
         and pid <> pg_backend_pid() order by query_start limit 1) as longest,
      (select string_agg(e || ':' || n, ';' order by n desc) from (select coalesce(wait_event, 'CPU') as e, count(*) as n
         from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() group by 1) x) as waits`;
  const [d] = await sql`select (xact_commit + xact_rollback)::float as xacts, blks_hit::float as hit, blks_read::float as rd
    from pg_stat_database where datname = current_database()`;
  const now = Date.now();
  const tps = last ? ((d.xacts - last.xacts) / ((now - last.at) / 1000)).toFixed(1) : '';
  const reads = last ? d.hit - last.hit + (d.rd - last.rd) : 0;
  const hit = last && reads > 0 ? (((d.hit - last.hit) / reads) * 100).toFixed(2) : '';
  last = { ...d, at: now };
  appendFileSync(out, [Math.round(now / 1000), a.total, a.active, a.idle, a.idle_in_tx, a.waiting_lock, a.longest.toFixed(1), w.longest ?? '', w.waits ?? '', tps, hit,
    ...proc(pids.web), ...proc(pids.console), k6cpu().toFixed(0)].join(',') + '\n');
}

let stop = false;
process.on('SIGTERM', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });
while (!stop) {
  // A dropped network must cost one row, not the rest of the run.
  const timeout = new Promise((_, no) => setTimeout(() => no(new Error('sample took over 4 s')), 4000));
  await Promise.race([sample(), timeout]).catch((err) => console.error('[sampler]', new Date().toISOString(), err instanceof Error ? err.message : err));
  await new Promise((r) => setTimeout(r, 5000));
}
await sql.end({ timeout: 2 });
process.exit(0);
