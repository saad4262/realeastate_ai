// PLATFORM-PLAN 4.3: one run's files (load/runs/<time>/) → three outputs:
//   report.html  charts and tables per kind of user, the bottlenecks found with their evidence, errors and logs
//   results.md   the same findings as text, to paste into a conversation (Claude) or a ticket
//   results.json the numbers, for a later comparison
// node load/report.mjs load/runs/<time>     (run.sh calls it)
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { constants, createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { ENDPOINTS, ROLES, population } from './catalog.js';

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, 'k6.csv.gz'))) throw new Error('usage: node load/report.mjs load/runs/<time>');
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
const json = (f) => {
  try {
    return JSON.parse(read(f) || 'null');
  } catch {
    return null;
  }
};

// ---------- the run's settings ----------
const argsText = read('args.txt');
const env = Object.fromEntries([...argsText.matchAll(/-e ([A-Z_]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
const poolLine = argsText.match(/DB_POOL_MAX=(\d+)/);
const MODE = env.MODE ?? 'smoke';
const PROFILE = env.PROFILE ?? 'pop';
const pop = population(env);
const toSec = (d) => (d.endsWith('m') ? Number(d.slice(0, -1)) * 60 : d.endsWith('s') ? Number(d.slice(0, -1)) : Number(d));
const RAMP = MODE === 'run' ? toSec(env.RAMP ?? '2m') : 0;
const HOLD = MODE === 'run' ? toSec(env.HOLD ?? '5m') : MODE === 'smoke' ? 30 : MODE === 'soak' ? 7200 : 3600;
const byKind = Object.fromEntries(ENDPOINTS.map((e) => [e.kind, e]));
const profile = json('profile.json');
const poolMax = profile?.poolMax ?? (poolLine ? Number(poolLine[1]) : 5);
const APPS = 2; // web and console, one process each when run on one machine
// A person waits for the whole page, not its first byte: a streamed page sends its shell at once and the rest later.
const WHOLE_MAX_MS = 3000;
const appOf = (e) => (e.kind === 'system_health_console' ? 'console' : ROLES[e.role].app);

// ---------- every request ----------
const BUCKET = 5;
const kinds = new Map();
const buckets = new Map();
let t0 = Infinity;
let t1 = 0;
const stat = (k) => kinds.get(k) ?? kinds.set(k, { n: 0, bad: 0, waits: [], fulls: [], status: {}, why: {}, dropped: 0, times: [] }).get(k);
const cell = (t, k) => {
  const b = buckets.get(t) ?? buckets.set(t, new Map()).get(t);
  return b.get(k) ?? b.set(k, { n: 0, bad: 0, fulls: [] }).get(k);
};

// Why a request did not succeed, in words.
function reason(status, error) {
  const e = (error || '').toLowerCase();
  if (status === 0) {
    if (e.includes('timeout') || e.includes('deadline')) return 'no answer within the timeout';
    if (e.includes('reset')) return 'connection reset by the server (it stopped accepting)';
    if (e.includes('refused')) return 'connection refused (server down or full)';
    return `network error: ${error || 'unknown'}`;
  }
  if (status >= 300 && status < 400) return `${status} redirect (a signed-in page sent its person to sign in)`;
  if (status === 401 || status === 403) return `${status} refused (not signed in or not allowed)`;
  if (status === 429) return '429 rate limited';
  if (status === 503) return '503 unavailable (the app shed the request, or Auth/DB not reachable)';
  if (status >= 500) return `${status} server error`;
  return `${status}`;
}

// k6 quotes a field that holds a comma (an error message can), so a plain split would shift the columns after it.
function fields(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// A run cut short leaves the gzip unfinished: read what is there.
const lines = createInterface({ input: createReadStream(join(dir, 'k6.csv.gz')).pipe(createGunzip({ finishFlush: constants.Z_SYNC_FLUSH })) });
let col = null;
for await (const line of lines) {
  const f = fields(line);
  if (!col) {
    col = Object.fromEntries(f.map((name, i) => [name, i]));
    continue;
  }
  const metric = f[col.metric_name];
  const kind = f[col.scenario];
  if (!kind || !byKind[kind]) continue; // the half-written last line of a run cut short, or an older run's names
  if (metric === 'dropped_iterations') {
    stat(kind).dropped += Number(f[col.metric_value]);
    continue;
  }
  if (metric !== 'http_reqs' && metric !== 'http_req_waiting' && metric !== 'http_req_duration') continue;
  const t = Number(f[col.timestamp]);
  const tb = t - (t % BUCKET);
  t0 = Math.min(t0, t);
  t1 = Math.max(t1, t);
  const v = Number(f[col.metric_value]);
  const k = stat(kind);
  const c = cell(tb, kind);
  if (metric === 'http_reqs') {
    const status = Number(f[col.status] || 0);
    k.n += 1;
    c.n += 1;
    k.times.push(t);
    k.status[status] = (k.status[status] ?? 0) + 1;
    if (status < 200 || status >= 300) {
      k.bad += 1;
      c.bad += 1;
      const why = reason(status, f[col.error]);
      k.why[why] = (k.why[why] ?? 0) + 1;
    }
  } else if (metric === 'http_req_waiting') k.waits.push(v);
  else {
    k.fulls.push(v);
    c.fulls.push(v);
  }
}
if (!kinds.size) throw new Error('No requests of catalog.js kinds in k6.csv.gz (a run from before catalog.js?)');

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const seconds = Math.max(1, t1 - t0 + 1);
const holdFrom = t0 + RAMP;
const holdTo = holdFrom + HOLD;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ---------- per kind ----------
const rows = ENDPOINTS.filter((e) => kinds.has(e.kind)).map((e) => {
  const k = kinds.get(e.kind);
  const target = Math.max(1, Math.round(PROFILE === 'pop' ? e.perMin(pop) : 0));
  const p95 = pct(k.waits, 95);
  const alone = profile?.endpoints?.[e.kind];
  const okPct = ((k.n - k.bad) / k.n) * 100;
  return {
    kind: e.kind, role: e.role, method: e.method, path: e.path, does: e.does, code: e.code, budget: e.budget,
    targetPerMin: PROFILE === 'pop' ? target : null, sent: k.n, okPct,
    p50: pct(k.waits, 50), p95, p99: pct(k.waits, 99), full95: pct(k.fulls, 95), dropped: k.dropped,
    full95Max: Math.max(e.budget, WHOLE_MAX_MS),
    pass: p95 !== null && p95 < e.budget && okPct >= 99 && pct(k.fulls, 95) < Math.max(e.budget, WHOLE_MAX_MS),
    why: Object.entries(k.why).sort((a, b) => b[1] - a[1]), status: k.status,
    alone: alone ? { status: alone.first.status, firstMs: alone.first.totalMs, secondMs: alone.second.totalMs, statements: alone.first.statements, statementsCached: alone.second.statements } : null,
  };
});
const total = sum(rows.map((r) => r.sent));
const totalBad = sum([...kinds.values()].map((k) => k.bad));

// ---------- over time ----------
const times = [...buckets.keys()].sort((a, b) => a - b);
const tStart = times[0];
const label = (t) => {
  const s = Math.max(0, t - tStart);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const timeline = times.map((t) => {
  const all = [...buckets.get(t).values()];
  const n = sum(all.map((c) => c.n));
  const bad = sum(all.map((c) => c.bad));
  return { t, n, bad, errPct: n ? (bad / n) * 100 : 0 };
});
// Where the setup stopped coping: the first two 5 s windows in a row with more than 1% failures.
let knee = null;
for (let i = 0; i + 1 < timeline.length; i += 1) {
  if (timeline[i].errPct > 1 && timeline[i + 1].errPct > 1 && timeline[i].n > 20) {
    knee = { at: label(timeline[i].t), sentPerSec: (timeline[Math.max(0, i - 1)].n || timeline[i].n) / BUCKET };
    break;
  }
}
const bestHealthy = Math.max(0, ...timeline.filter((x) => x.errPct <= 1 && x.n > 0).map((x) => x.n / BUCKET));

const series = {
  labels: times.map(label),
  roles: Object.fromEntries(Object.keys(ROLES).map((role) => {
    const ks = rows.filter((r) => r.role === role).map((r) => r.kind);
    const at = (t, k, f) => buckets.get(t).get(k)?.[f] ?? 0;
    return [role, {
      ok: times.map((t) => (sum(ks.map((k) => at(t, k, 'n'))) - sum(ks.map((k) => at(t, k, 'bad')))) / BUCKET),
      bad: times.map((t) => sum(ks.map((k) => at(t, k, 'bad'))) / BUCKET),
      p95: ks.map((k) => ({ label: k.replace(`${role}_`, ''), data: times.map((t) => {
        const v = pct(buckets.get(t).get(k)?.fulls ?? [], 95);
        return v === null ? null : Math.round(v);
      }) })),
    }];
  })),
  total: timeline.map((x) => x.n / BUCKET),
  errPct: timeline.map((x) => Number(x.errPct.toFixed(1))),
};

// ---------- the database and the machines ----------
const samples = read('samples.csv').trim().split('\n').filter(Boolean);
const sh = samples.length > 1 ? samples[0].split(',') : [];
const srows = samples.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [sh[i], v === '' ? null : Number(v)])));
const res = { labels: srows.map((r) => label(r.t)) };
for (const k of ['connections', 'active', 'idle', 'idle_in_tx', 'waiting_lock', 'tps', 'cache_hit_pct', 'longest_active_s', 'web_cpu', 'console_cpu', 'k6_cpu', 'web_rss_mb', 'console_rss_mb']) res[k] = srows.map((r) => r[k]);
const vals = (k) => res[k].filter((v) => v !== null && !Number.isNaN(v));
const peak = (k) => Math.max(0, ...vals(k));
const lowest = (k) => (vals(k).length ? Math.min(...vals(k)) : 100);

// ---------- bottlenecks ----------
const findings = [];
const add = (severity, title, evidence, meaning, next) => findings.push({ severity, title, evidence, meaning, next });
const rtt = profile?.rttMs ?? null;
const ok2xx = (s) => s >= 200 && s < 300;
const measured = rows.filter((r) => r.alone && ok2xx(r.alone.status));
// Statements a second each app's pool would have to carry at the target rates, from the one-by-one profile.
const perApp = ['web', 'console'].map((app) => {
  const rs = measured.filter((r) => appOf(byKind[r.kind]) === app);
  const reqPerSec = PROFILE === 'pop' ? sum(rs.map((r) => r.targetPerMin / 60)) : 0;
  const stmtsPerSec = PROFILE === 'pop' ? sum(rs.map((r) => (r.targetPerMin / 60) * r.alone.statements)) : 0;
  const capacity = rtt ? poolMax / (rtt / 1000) : null;
  return { app, reqPerSec, stmtsPerSec, avg: reqPerSec ? stmtsPerSec / reqPerSec : 0, capacity, roomReqPerSec: capacity && reqPerSec ? capacity / (stmtsPerSec / reqPerSec) : null };
});
if (rtt !== null && rtt > 20) {
  add('critical', 'The app servers are far from the database',
    `One query's round trip from the app servers to the database: ${rtt.toFixed(0)} ms. In production (Vercel syd1 to Supabase Sydney) it is about 1–2 ms.`,
    `Every database statement waits ${rtt.toFixed(0)} ms on the network. A request of 10 statements cannot take less than ${((rtt * 10) / 1000).toFixed(1)} s, whatever the code does.`,
    'Run the servers next to the database (a Vercel preview on dev, or a machine in Sydney). Until then these numbers describe the network, not the platform.');
}
if (rtt !== null && PROFILE === 'pop' && measured.length) {
  const over = perApp.filter((a) => a.capacity !== null && a.stmtsPerSec > a.capacity);
  add(over.length ? 'critical' : 'info', over.length ? `The connection pool is the ceiling (${over.map((a) => a.app).join(' and ')})` : 'The connection pools had room',
    perApp.map((a) => `${a.app}: ${poolMax} connections, each busy ${rtt.toFixed(0)} ms per statement → at most ${a.capacity.toFixed(0)} statements/s; the target needs ~${a.stmtsPerSec.toFixed(0)}/s (${a.reqPerSec.toFixed(0)} requests/s × ${a.avg.toFixed(1)} statements each, from the profile) → room for about ${a.roomReqPerSec === null ? '—' : a.roomReqPerSec.toFixed(1)} requests/s`).join('. ') + '.',
    over.length ? 'Requests beyond that wait in line for a connection; the line grows until they time out (the "no answer within the timeout" failures).' : 'Pool size was not what limited this run.',
    `At a 2 ms round trip the same pool gives ~${(poolMax / 0.002).toFixed(0)} statements/s per app. In production each Vercel instance has its own pool (DB_POOL_MAX, 3.14): the limit there is instances × pool against the pooler's client limit.`);
}
if (knee) {
  add('critical', `The setup stopped coping at about ${knee.sentPerSec.toFixed(0)} requests/s`,
    `Failures first passed 1% at ${knee.at} into the run, while ${knee.sentPerSec.toFixed(0)} requests/s were being sent. The best 5 seconds with ≤ 1% failures carried ${bestHealthy.toFixed(0)} requests/s.`,
    'Above this rate the run measures a queue, not the platform.', 'Compare with the pool ceiling: when the two agree, the pool (and the round trip behind it) is the cause.');
} else if ((totalBad / total) * 100 >= 1) {
  const byRole = Object.keys(ROLES).map((role) => {
    const rs = rows.filter((r) => r.role === role);
    const n = sum(rs.map((r) => r.sent));
    return n ? `${ROLES[role].label} ${(100 - (sum(rs.map((r) => r.sent * (r.okPct / 100))) / n) * 100).toFixed(0)}%` : null;
  }).filter(Boolean);
  add('critical', 'Requests failed from the start, with no point where it still coped', `Failed share by user: ${byRole.join(', ')}. Best 5 seconds with ≤ 1% failures: ${bestHealthy.toFixed(0)} requests/s.`,
    'Even the lowest rate in this run was more than the setup could carry.', 'Lower the rate (fewer AGENTS/USERS) to find the knee, or remove the cause above.');
} else {
  add('info', 'No knee: failures stayed at or under 1% throughout', `Best rate carried: ${bestHealthy.toFixed(0)} requests/s.`, 'The setup held the whole load.', 'Raise AGENTS/USERS until a knee appears.');
}
if (samples.length > 1) {
  const busy = peak('active');
  const dbIdle = busy < poolMax * APPS && peak('waiting_lock') === 0;
  add(dbIdle ? 'info' : 'warning', dbIdle ? 'The database itself was not busy' : 'The database was busy',
    `Peak connections ${peak('connections')}, peak active ${busy}, peak transactions ${peak('tps').toFixed(0)}/s, waiting on a lock ${peak('waiting_lock')}, longest running query ${peak('longest_active_s').toFixed(1)} s, lowest cache hit ${lowest('cache_hit_pct').toFixed(1)}%.`,
    dbIdle ? 'Postgres had spare capacity: the requests never reached it fast enough.' : 'Look at the slowest queries (pnpm db:slow-queries) and at lock waits.',
    dbIdle ? 'Not a database problem in this run.' : 'Indexes, statements per request, and the compute size.');
  const cpu = Math.max(peak('web_cpu'), peak('console_cpu'));
  if (cpu >= 90) add('warning', 'An app server ran out of CPU', `Peak CPU: web ${peak('web_cpu').toFixed(0)}%, console ${peak('console_cpu').toFixed(0)}% (100% = one core; one Node process uses about one core).`, 'Rendering, not waiting, limited that app.', 'In production Vercel adds instances; locally run more processes or make the page lighter.');
  else add('info', 'The app servers had CPU to spare', `Peak CPU: web ${peak('web_cpu').toFixed(0)}%, console ${peak('console_cpu').toFixed(0)}% (100% = one core).`, 'The apps were waiting, not working.', '—');
  if (peak('k6_cpu') >= 80) add('warning', 'The load generator was busy', `k6 peaked at ${peak('k6_cpu').toFixed(0)}% CPU.`, 'Some slowness may be k6\'s own.', 'Run k6 on a separate machine.');
}
const heavy = [...measured].sort((a, b) => b.alone.statements - a.alone.statements).slice(0, 6);
if (heavy.length) {
  add('warning', 'The requests that cost the most database work',
    heavy.map((r) => `${r.kind}: ${r.alone.statements} statements, ${(r.alone.firstMs / 1000).toFixed(2)} s alone (again: ${r.alone.statementsCached} statements, ${(r.alone.secondMs / 1000).toFixed(2)} s)`).join('; '),
    'These multiply first under load: statements × the round trip is their floor.', 'Fewer statements per request (combine reads, cache what does not change), or cache the page.');
}
const brokenAlone = rows.filter((r) => r.alone && !ok2xx(r.alone.status));
if (brokenAlone.length) {
  add('critical', 'Broken even with no load', brokenAlone.map((r) => `${r.kind} answered ${r.alone.status || 'nothing'} on its own`).join('; '),
    'Not a scale problem: these fail on a quiet server too.', 'Fix or check these first (server log in the Logs section).');
}
const slowAlone = measured.filter((r) => r.alone.secondMs > r.budget).sort((a, b) => b.alone.secondMs - a.alone.secondMs);
if (slowAlone.length) {
  add('info', 'Over budget with no load at all', slowAlone.slice(0, 8).map((r) => `${r.kind} ${(r.alone.secondMs / 1000).toFixed(2)} s (budget ${r.budget} ms)`).join('; '),
    rtt !== null && rtt > 20 ? 'Mostly the round trip × each request\'s statements.' : 'Slow at rest: the code path, not the load.', 'Re-measure next to the database before changing code.');
}
const redirects = rows.filter((r) => r.why.some(([w]) => w.includes('redirect')));
if (redirects.length) add('warning', 'Signed-in requests were sent to the sign-in page', redirects.map((r) => r.kind).join(', '), 'Those sessions expired or were refused during the run, so those numbers are not real page loads.', 'Make sessions right before a run (node load/sessions.mjs); keep runs shorter than the access token.');
const droppedTotal = sum(rows.map((r) => r.dropped));
if (droppedTotal > 0) add('warning', `${droppedTotal.toLocaleString()} requests were never sent`, 'k6 had no free virtual user: every one was still waiting on an earlier, slow request.', 'Even more load was asked for than these numbers show.', 'Same cause as the knee.');
const order = { critical: 0, warning: 1, info: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
const cutShort = !read('summary.json');

// ---------- results.md / results.json ----------
const ms = (v) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const failedPct = (totalBad / total) * 100;
const verdict = knee
  ? `Held up to about ${knee.sentPerSec.toFixed(0)} requests/s, then failed (${failedPct.toFixed(0)}% of all requests).`
  : failedPct >= 1 ? `Did not hold: ${failedPct.toFixed(0)}% of requests failed.` : `Held the whole run: ${failedPct.toFixed(2)}% failed.`;
const meta = { dir, started: new Date(t0 * 1000).toISOString(), seconds, mode: MODE, profile: PROFILE, population: pop, poolMax, rttMs: rtt, cutShort, args: argsText.trim() };

const md = [];
md.push(`# Load run ${dir.split('/').pop()}`, '');
md.push(`- Mode ${MODE}, profile ${PROFILE}${PROFILE === 'pop' ? ` — online at once: ${pop.agencies} agencies, ${pop.agents} agents, ${pop.owners} owners, ${Math.round(pop.visitors)} visitors, ${Math.round(pop.buyers)} signed-in buyers, ${pop.admins} platform admins` : ''}`);
md.push(`- Started ${meta.started}, ran ${Math.floor(seconds / 60)} min ${seconds % 60} s${cutShort ? ' (cut short: k6 did not finish)' : ''}`);
md.push(`- Database round trip from the app servers: ${rtt === null ? 'not measured' : `${rtt.toFixed(0)} ms`}; pool ${poolMax} per app × ${APPS} apps`);
md.push(`- Requests ${total.toLocaleString()}, failed ${failedPct.toFixed(2)}%`, '', `**Verdict:** ${verdict}`, '');
md.push('## Bottlenecks, most serious first', '');
findings.forEach((f, i) => md.push(`${i + 1}. **[${f.severity}] ${f.title}.** ${f.evidence} *Meaning:* ${f.meaning} *Next:* ${f.next}`));
for (const [role, info] of Object.entries(ROLES)) {
  const rs = rows.filter((r) => r.role === role);
  if (!rs.length) continue;
  md.push('', `## ${info.label} — ${info.who}`, '');
  md.push('| Request | Simulates | Target/min | Sent | OK | First byte p50 / p95 | Whole p95 | Alone: time, DB statements | Budget | Result | Failures |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rs) {
    md.push(`| \`${r.method} ${r.path}\` | ${r.does} | ${r.targetPerMin ?? '—'} | ${r.sent} | ${r.okPct.toFixed(1)}% | ${ms(r.p50)} / ${ms(r.p95)} | ${ms(r.full95)} | ${r.alone ? `${ms(r.alone.firstMs)}, ${r.alone.statements}` : '—'} | ${r.budget} ms first byte, ${r.full95Max} ms whole | ${r.pass ? 'pass' : 'FAIL'} | ${r.why.slice(0, 2).map(([w, n]) => `${n}× ${w}`).join('; ') || '—'} |`);
  }
}
md.push('', '## Database and machines (peaks)', '');
md.push(samples.length > 1 ? `Connections ${peak('connections')}, active ${peak('active')}, transactions ${peak('tps').toFixed(0)}/s, lock waits ${peak('waiting_lock')}, longest query ${peak('longest_active_s').toFixed(1)} s, lowest cache hit ${lowest('cache_hit_pct').toFixed(1)}%; CPU web ${peak('web_cpu').toFixed(0)}%, console ${peak('console_cpu').toFixed(0)}%, k6 ${peak('k6_cpu').toFixed(0)}% (100% = one core).` : 'Not sampled.');
md.push('', '## How this run was made', '', 'k6 sends each request at its own rate (load/catalog.js: who, what, how often); every request is in k6.csv.gz. Before the load, load/profile.mjs called each request alone and counted its database statements (profile.json). load/sampler.mjs read the database and the machines every 5 s (samples.csv). Code: load/ on branch test/4.3-load-runs.');
writeFileSync(join(dir, 'results.md'), `${md.join('\n')}\n`);
writeFileSync(join(dir, 'results.json'), JSON.stringify({ meta, verdict, findings, rows, peaks: samples.length > 1 ? Object.fromEntries(['connections', 'active', 'tps', 'waiting_lock', 'longest_active_s', 'web_cpu', 'console_cpu', 'k6_cpu'].map((k) => [k, peak(k)])) : null }, null, 1));

// ---------- report.html ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const logBlock = (name, text, max = 150) => {
  const all = text.trim().split('\n').filter(Boolean);
  return `<details><summary>${esc(name)} <span class="mute">— ${all.length} lines</span></summary><pre>${esc(all.slice(0, max).join('\n') || 'none')}${all.length > max ? `\n… ${all.length - max} more in the file` : ''}</pre></details>`;
};
const roleSections = Object.entries(ROLES).map(([role, info]) => {
  const rs = rows.filter((r) => r.role === role);
  if (!rs.length) return '';
  const sent = sum(rs.map((r) => r.sent));
  const ok = sent ? (sum(rs.map((r) => r.sent * (r.okPct / 100))) / sent) * 100 : 0;
  return `<section id="${role}" class="role">
<div class="role-head"><div><h3>${esc(info.label)}</h3><p class="mute">${esc(info.who)}</p></div>
<div class="pills"><span class="pill">${rs.length} kinds of request</span><span class="pill">${sent.toLocaleString()} sent</span><span class="pill ${ok >= 99 ? 'good' : 'bad'}">${ok.toFixed(1)}% OK</span></div></div>
<div class="grid2"><div class="card"><div class="card-t">Requests a second: succeeded and failed</div><div class="chart"><canvas id="rate-${role}"></canvas></div></div>
<div class="card"><div class="card-t">Whole response p95 per request (ms) — click a name to hide it</div><div class="chart"><canvas id="lat-${role}"></canvas></div></div></div>
<div class="wrap"><table><thead><tr><th>Request</th><th>What it simulates</th><th>Target /min</th><th>Sent</th><th>OK</th><th>First byte p50 / p95</th><th>Whole p95</th><th>Alone (no load)</th><th>Budget</th><th>Result</th></tr></thead><tbody>
${rs.map((r) => `<tr><td><code>${esc(r.method)} ${esc(r.path)}</code><div class="sub">${esc(r.kind)}</div></td><td>${esc(r.does)}<div class="sub">${esc(r.code)}</div></td><td class="n">${r.targetPerMin ?? '—'}</td><td class="n">${r.sent.toLocaleString()}${r.dropped ? `<div class="sub">${r.dropped.toLocaleString()} never sent</div>` : ''}</td><td class="n ${r.okPct >= 99 ? 'good' : 'bad'}">${r.okPct.toFixed(1)}%</td><td class="n">${ms(r.p50)} / ${ms(r.p95)}</td><td class="n">${ms(r.full95)}</td><td class="n">${r.alone ? `${ms(r.alone.firstMs)}<div class="sub">${r.alone.statements} DB statements${ok2xx(r.alone.status) ? '' : `, answered ${r.alone.status || 'nothing'}`}</div>` : '—'}</td><td class="n">${r.budget} ms<div class="sub">whole ≤ ${ms(r.full95Max)}</div></td><td><span class="tag ${r.pass ? 'good' : 'bad'}">${r.pass ? 'pass' : 'fail'}</span>${r.why.length ? `<div class="sub">${r.why.slice(0, 2).map(([w, n]) => `${n.toLocaleString()}× ${esc(w)}`).join('<br>')}</div>` : ''}</td></tr>`).join('')}
</tbody></table></div></section>`;
}).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Load Run Report</title>
<style>
:root{--bg:#f6f5f2;--fg:#1a1917;--mute:#6b6862;--line:#e3e0da;--card:#fff;--head:#f1efea;--good:#157a3c;--goodbg:#e4f4ea;--bad:#b42318;--badbg:#fdecea;--warn:#a15c07;--warnbg:#fdf3e1;--info:#2f5d9e;--infobg:#e8eff9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121110;--fg:#f2f0ec;--mute:#a19d96;--line:#2c2a27;--card:#1b1a18;--head:#201f1d;--good:#5bd38a;--goodbg:#173322;--bad:#ff8a7a;--badbg:#3a1c18;--warn:#f2b45a;--warnbg:#38290f;--info:#8fb4ee;--infobg:#1a2638}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1240px;margin:0 auto;padding:28px 16px 64px}h1{font-size:24px;margin:0;letter-spacing:-.01em}h2{font-size:17px;margin:40px 0 12px}h3{font-size:16px;margin:0}
p{margin:4px 0}.mute{color:var(--mute)}code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
nav{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);margin:16px -16px 0;padding:8px 16px;display:flex;gap:6px;flex-wrap:wrap}
nav a{color:var(--fg);text-decoration:none;padding:4px 10px;border-radius:999px;border:1px solid var(--line);font-size:13px;background:var(--card)}nav a:hover{border-color:var(--mute)}
.verdict{margin-top:16px;padding:16px 18px;border-radius:12px;border:1px solid var(--line);background:var(--card);display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.verdict b{font-size:17px}.btn{cursor:pointer;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:7px 12px;font:inherit;font-size:13px}.btn:hover{border-color:var(--mute)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:14px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile span{font-size:12px;color:var(--mute)}.tile b{display:block;font-size:21px;font-variant-numeric:tabular-nums;margin-top:2px}
.finding{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--info);border-radius:10px;padding:12px 16px;margin:10px 0}
.finding.critical{border-left-color:var(--bad)}.finding.warning{border-left-color:var(--warn)}.finding h4{margin:0 0 8px;font-size:15px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.finding dl{display:grid;grid-template-columns:76px 1fr;gap:4px 12px;margin:0}.finding dt{color:var(--mute);font-size:12.5px;padding-top:1px}.finding dd{margin:0}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
.tag.critical,.tag.bad{background:var(--badbg);color:var(--bad)}.tag.warning{background:var(--warnbg);color:var(--warn)}.tag.info{background:var(--infobg);color:var(--info)}.tag.good{background:var(--goodbg);color:var(--good)}
.role{margin-top:28px}.role-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px}
.pills{display:flex;gap:6px;flex-wrap:wrap}.pill{font-size:12.5px;padding:3px 10px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-variant-numeric:tabular-nums}
.pill.good{color:var(--good);background:var(--goodbg);border-color:transparent}.pill.bad{color:var(--bad);background:var(--badbg);border-color:transparent}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:12px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}.card-t{font-size:12.5px;color:var(--mute);margin-bottom:6px}
.chart{position:relative;height:260px;width:100%}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;min-width:1000px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--mute);font-weight:600;background:var(--head)}tr:last-child td{border-bottom:0}td.n{text-align:right;white-space:nowrap}td:last-child{min-width:210px}
.sub{font-size:12px;color:var(--mute);margin-top:2px}.good{color:var(--good)}.bad{color:var(--bad)}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace;max-height:440px;overflow:auto;margin:8px 0 0}
details{margin:8px 0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}summary{cursor:pointer;font-weight:600}
</style></head><body><main>
<h1>Load run report</h1>
<p class="mute">${esc(meta.started.replace('T', ' ').slice(0, 19))} UTC · ${Math.floor(seconds / 60)} min ${seconds % 60} s · ${esc(MODE)} / ${esc(PROFILE)}${cutShort ? ' · <b class="bad">cut short</b>' : ''} · ${esc(dir)}</p>
${PROFILE === 'pop' ? `<p class="mute">Online at once: ${pop.agencies} agencies · ${pop.agents} agents · ${pop.owners} owners · ${Math.round(pop.visitors).toLocaleString()} visitors · ${Math.round(pop.buyers).toLocaleString()} signed-in buyers · ${pop.admins} platform admins</p>` : ''}
<nav><a href="#bottlenecks">Bottlenecks</a>${Object.entries(ROLES).filter(([r]) => rows.some((x) => x.role === r)).map(([r, i]) => `<a href="#${r}">${esc(i.label)}</a>`).join('')}<a href="#resources">Database &amp; machines</a><a href="#logs">Logs</a></nav>
<div class="verdict"><div><b>${esc(verdict)}</b><p class="mute">${findings[0] ? esc(`Main cause: ${findings[0].title}.`) : ''}</p></div><button class="btn" id="copy">Copy results for Claude</button></div>
<div class="tiles">
<div class="tile"><span>Requests</span><b>${total.toLocaleString()}</b></div>
<div class="tile"><span>Failed</span><b class="${failedPct < 1 ? 'good' : 'bad'}">${failedPct.toFixed(1)}%</b></div>
<div class="tile"><span>Best healthy rate</span><b>${bestHealthy.toFixed(0)}/s</b></div>
<div class="tile"><span>Peak rate sent</span><b>${Math.max(...series.total).toFixed(0)}/s</b></div>
<div class="tile"><span>DB round trip</span><b>${rtt === null ? '—' : `${rtt.toFixed(0)} ms`}</b></div>
<div class="tile"><span>Within budget</span><b class="${rows.every((r) => r.pass) ? 'good' : 'bad'}">${rows.filter((r) => r.pass).length} / ${rows.length}</b></div>
</div>

<h2 id="bottlenecks">Bottlenecks, most serious first</h2>
${findings.map((f) => `<div class="finding ${f.severity}"><h4><span class="tag ${f.severity}">${f.severity}</span>${esc(f.title)}</h4><dl><dt>Evidence</dt><dd>${esc(f.evidence)}</dd><dt>Meaning</dt><dd>${esc(f.meaning)}</dd><dt>Next</dt><dd>${esc(f.next)}</dd></dl></div>`).join('')}
<div class="card" style="margin-top:12px"><div class="card-t">All requests: sent a second (bars) and failed % (line)</div><div class="chart"><canvas id="overall"></canvas></div></div>

<h2>By kind of user</h2>
${roleSections}

<h2 id="resources">Database &amp; machines</h2>
<div class="grid2">
<div class="card"><div class="card-t">Database connections by state; transactions a second (right axis)</div><div class="chart"><canvas id="db"></canvas></div></div>
<div class="card"><div class="card-t">CPU (100 = one core): the two app servers and k6</div><div class="chart"><canvas id="cpu"></canvas></div></div>
<div class="card"><div class="card-t">Longest running query (s); lock waits (right axis)</div><div class="chart"><canvas id="slow"></canvas></div></div>
<div class="card"><div class="card-t">App server memory (MB)</div><div class="chart"><canvas id="mem"></canvas></div></div>
</div>

<h2 id="logs">Logs</h2>
${logBlock('Each request alone, before the load (profile)', read('profile.txt'))}
${logBlock('After-run checks (every count must be 0)', read('after-run.txt'))}
${logBlock('Web server errors during the run', read('web-errors.txt'))}
${logBlock('Console server errors during the run', read('console-errors.txt'))}
${logBlock('k6 warnings', read('k6.log'), 80)}
${logBlock('Sampler', read('sampler.log'))}
${logBlock('results.md (what the copy button copies)', md.join('\n'), 400)}
<p class="mute">Beside this file: k6.csv.gz (every request), profile.json, samples.csv, summary.json, results.json, results.md, the server logs.</p>
</main>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
const S = ${JSON.stringify(series)}, R = ${JSON.stringify(res)}, MD = ${JSON.stringify(md.join('\n'))};
document.getElementById('copy').onclick = async (e) => { try { await navigator.clipboard.writeText(MD); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy failed: open results.md'; } };
if (window.Chart) {
  const css = getComputedStyle(document.documentElement), v = (n) => css.getPropertyValue(n).trim();
  Chart.defaults.color = v('--mute'); Chart.defaults.borderColor = v('--line'); Chart.defaults.font.size = 11; Chart.defaults.animation = false;
  const PAL = ['#2f6fdb','#d9480f','#2b8a3e','#ae3ec9','#e8590c','#0c8599','#c2255c','#5f3dc4','#868e96','#74b816','#1971c2','#f08c00'];
  const base = (extra = {}) => ({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, elements: { point: { radius: 0 }, line: { borderWidth: 1.6, tension: 0.25 } }, plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } } }, ...extra, scales: { x: { ticks: { maxTicksLimit: 9 } }, ...(extra.scales || {}) } });
  const mk = (id, type, labels, datasets, extra) => { const el = document.getElementById(id); if (el) new Chart(el, { type, data: { labels, datasets }, options: base(extra) }); };
  mk('overall', 'bar', S.labels, [{ type: 'bar', label: 'sent /s', data: S.total, backgroundColor: '#2f6fdb88', yAxisID: 'y' }, { type: 'line', label: 'failed %', data: S.errPct, borderColor: '#d63b2f', backgroundColor: '#d63b2f', yAxisID: 'y1' }], { scales: { y: { beginAtZero: true, title: { display: true, text: 'requests/s' } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'failed %' } } } });
  for (const [role, d] of Object.entries(S.roles)) {
    mk('rate-' + role, 'line', S.labels, [{ label: 'succeeded /s', data: d.ok, borderColor: '#2b8a3e', backgroundColor: '#2b8a3e33', fill: true }, { label: 'failed /s', data: d.bad, borderColor: '#d63b2f', backgroundColor: '#d63b2f33', fill: true }], { scales: { y: { beginAtZero: true } } });
    mk('lat-' + role, 'line', S.labels, d.p95.map((s, i) => ({ ...s, borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length], spanGaps: true })), { scales: { y: { beginAtZero: true, title: { display: true, text: 'ms' } } } });
  }
  mk('db', 'line', R.labels, [{ label: 'connections', data: R.connections, borderColor: '#868e96' }, { label: 'active', data: R.active, borderColor: '#2f6fdb' }, { label: 'idle in transaction', data: R.idle_in_tx, borderColor: '#e8590c' }, { label: 'transactions /s', data: R.tps, borderColor: '#2b8a3e', yAxisID: 'y1' }], { scales: { y: { beginAtZero: true }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } } });
  mk('cpu', 'line', R.labels, [{ label: 'web', data: R.web_cpu, borderColor: '#2f6fdb' }, { label: 'console', data: R.console_cpu, borderColor: '#ae3ec9' }, { label: 'k6', data: R.k6_cpu, borderColor: '#868e96' }], { scales: { y: { beginAtZero: true } } });
  mk('slow', 'line', R.labels, [{ label: 'longest query s', data: R.longest_active_s, borderColor: '#d9480f' }, { label: 'waiting on a lock', data: R.waiting_lock, borderColor: '#c2255c', yAxisID: 'y1' }], { scales: { y: { beginAtZero: true }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } } });
  mk('mem', 'line', R.labels, [{ label: 'web', data: R.web_rss_mb, borderColor: '#2f6fdb' }, { label: 'console', data: R.console_rss_mb, borderColor: '#ae3ec9' }], { scales: { y: { beginAtZero: true } } });
} else {
  document.querySelectorAll('.chart').forEach((c) => { c.innerHTML = '<p class="mute">Charts need an internet connection (Chart.js from jsDelivr). The tables and results.md have every number.</p>'; c.style.height = 'auto'; });
}
</script></body></html>`;

writeFileSync(join(dir, 'report.html'), html);
console.log(`report.html, results.md, results.json: ${total.toLocaleString()} requests, ${rows.filter((r) => r.pass).length}/${rows.length} within budget. ${verdict}`);
