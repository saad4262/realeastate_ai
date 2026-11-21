// PLATFORM-PLAN 4.3: the platform under load. k6 (https://k6.io), run by hand, never in CI; normally through run.sh.
// What is requested, by whom and how often: catalog.js. Targets: targets.json (targets.mjs). Sessions: sessions.json
// (sessions.mjs). NEVER point it at production; every vendor must be faked on the target.
//   MODE   smoke (30 s, each request a few times) | run (ramp RAMP, hold HOLD, ramp down 1 min; 2m + 5m by default)
//          | step (find the knee: STEPS fractions of the full rate, each held STEP; catalog.js)
//          | load (60 min) | spike (a 9 am spike: 10x for 5 min) | soak (2 h)
//   PROFILE v1 | v2 | v3 (section 3's people online; catalog.js VERSIONS) | pop (AGENCIES, AGENTS, USERS alone)
//   WEB, AGENTS_URL, AGENCY_URL, ADMIN_URL: the servers (local *.lvh.me by default); STRIPE_WEBHOOK_SECRET: the target's.
//   VERCEL_BYPASS: a preview's "Protection Bypass for Automation" secret, sent on every request.
//   ONLY=agent,owner: only these roles. TIMEOUT: give up on a request after this long (10s: past that a person has
//   left, and a longer wait only measures the queue).
import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { check } from 'k6';
import { ENDPOINTS, SESSION_OF, VERSIONS, baseUrl, body, fill, population, stepStages, wholeBudget } from './catalog.js';

const MODE = __ENV.MODE || 'smoke';
const PROFILE = __ENV.PROFILE || 'v1';
if (PROFILE !== 'pop' && !VERSIONS[PROFILE]) throw new Error(`PROFILE must be v1, v2, v3 or pop, not ${PROFILE}`);
const WEBHOOK_SECRET = __ENV.STRIPE_WEBHOOK_SECRET || '';
const TIMEOUT = __ENV.TIMEOUT || '10s';
const ONLY = (__ENV.ONLY || '').split(',').filter(Boolean);
const urls = ENDPOINTS.map((e) => baseUrl(e.role, e.kind, __ENV)).join(' ');
if (/findoraaus\.com\.au/.test(urls)) throw new Error('Refusing: that is production');

const targets = JSON.parse(open('./targets.json'));
let sessions = {};
try {
  sessions = JSON.parse(open('./sessions.json'));
} catch {
  sessions = {};
}

// Requests a minute per kind: every profile is a population of people with their habits (catalog.js).
const pop = population(__ENV);
const perMin = (e) => e.perMin(pop);

const usable = (e) => {
  if (ONLY.length && !ONLY.includes(e.role)) return false;
  const pool = SESSION_OF[e.role];
  if (pool && !(sessions[pool] || []).length) return false;
  if (e.kind === 'system_stripe_webhook' && !WEBHOOK_SECRET) return false;
  return perMin(e) > 0;
};
const active = ENDPOINTS.filter(usable);

function scenario(e) {
  const rate = Math.max(1, Math.round(perMin(e)));
  const perSec = rate / 60;
  const vus = Math.ceil(perSec * (MODE === 'spike' ? 10 : 1) * 4) + 2;
  const base = { exec: 'hit', timeUnit: '1m', tags: { kind: e.kind, role: e.role } };
  if (MODE === 'smoke') return { ...base, executor: 'constant-arrival-rate', rate: 6, duration: '30s', preAllocatedVUs: 1, maxVUs: 3 };
  if (MODE === 'run') {
    return { ...base, executor: 'ramping-arrival-rate', startRate: 0, preAllocatedVUs: vus, maxVUs: vus * 8,
      stages: [{ target: rate, duration: __ENV.RAMP || '2m' }, { target: rate, duration: __ENV.HOLD || '5m' }, { target: 0, duration: '1m' }] };
  }
  if (MODE === 'step') {
    return { ...base, executor: 'ramping-arrival-rate', startRate: 0, preAllocatedVUs: vus, maxVUs: vus * 8, stages: stepStages(rate, __ENV) };
  }
  if (MODE === 'spike') {
    return { ...base, executor: 'ramping-arrival-rate', startRate: rate, preAllocatedVUs: vus, maxVUs: vus * 4,
      stages: [{ target: rate, duration: '5m' }, { target: rate * 10, duration: '30s' }, { target: rate * 10, duration: '5m' }, { target: rate, duration: '30s' }, { target: rate, duration: '5m' }] };
  }
  return { ...base, executor: 'constant-arrival-rate', rate, duration: MODE === 'soak' ? '120m' : '60m', preAllocatedVUs: vus, maxVUs: vus * 4 };
}

export const options = {
  scenarios: Object.fromEntries(active.map((e) => [e.kind, scenario(e)])),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Any iteration k6 could not start means it sent less than asked: the run is not valid (report.mjs says so).
    dropped_iterations: ['count==0'],
    ...Object.fromEntries(active.map((e) => [`http_req_waiting{kind:${e.kind}}`, [`p(95)<${e.budget}`]])),
    // A streamed page sends its first byte at once; the person waits for the whole of it.
    ...Object.fromEntries(active.map((e) => [`http_req_duration{kind:${e.kind}}`, [`p(95)<${wholeBudget(e)}`]])),
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: true,
};

// Only a 2xx is a success: a signed-in page that redirects has sent its person to the sign-in page.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }));

const byKind = Object.fromEntries(ENDPOINTS.map((e) => [e.kind, e]));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
// Every visitor arrives from their own address, as on the internet; per-IP limits then count them apart.
const visitorIp = () => `10.${__VU % 250}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

export function hit() {
  const e = byKind[exec.scenario.name];
  const headers = { 'x-forwarded-for': visitorIp() };
  if (__ENV.VERCEL_BYPASS) headers['x-vercel-protection-bypass'] = __ENV.VERCEL_BYPASS;
  const pool = SESSION_OF[e.role];
  // One session per VU, so many people's data is read, not one person's a thousand times.
  if (pool) headers.cookie = sessions[pool][__VU % sessions[pool].length];
  const payload = body(e.kind, targets, pick, `${__VU}_${__ITER}`);
  if (payload) headers['content-type'] = 'application/json';
  if (e.kind === 'system_stripe_webhook') {
    const t = Math.floor(Date.now() / 1000);
    headers['stripe-signature'] = `t=${t},v1=${crypto.hmac('sha256', WEBHOOK_SECRET, `${t}.${payload}`, 'hex')}`;
  }
  const res = http.request(e.method, `${baseUrl(e.role, e.kind, __ENV)}${fill(e.path, targets, pick)}`, payload, {
    headers, timeout: TIMEOUT, redirects: pool ? 0 : 5, tags: { kind: e.kind, role: e.role },
  });
  check(res, { ok: (r) => r.status >= 200 && r.status < 300 }, { kind: e.kind, role: e.role });
}
