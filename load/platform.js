// PLATFORM-PLAN 4.3: the platform under load. k6 (https://k6.io), run by hand, never in CI:
//   k6 run -e MODE=load -e PROFILE=v2 -e WEB=https://<web preview> -e CONSOLE=https://<console preview> \
//          -e CONSOLE_COOKIE='<session cookie>' -e STRIPE_WEBHOOK_SECRET=<the preview's test secret> load/platform.js
// MODE: smoke (30 s, proves the script) | load (60 min) | spike (a 9 am spike: 10x for 5 min) | soak (2 h).
// PROFILE: v1 | v2 | v3 (PLATFORM-PLAN section 3; V1 must pass at v2). Targets: load/targets.json (load/targets.mjs).
// NEVER point it at production. Every vendor must be faked on the target (no live SMS, email, AI or Stripe).
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

const MODE = __ENV.MODE || 'smoke';
const PROFILE = __ENV.PROFILE || 'v1';
const WEB = (__ENV.WEB || 'http://localhost:3000').replace(/\/$/, '');
const CONSOLE = (__ENV.CONSOLE || '').replace(/\/$/, '');
const COOKIE = __ENV.CONSOLE_COOKIE || '';
const WEBHOOK_SECRET = __ENV.STRIPE_WEBHOOK_SECRET || '';
if (/findoraaus\.com\.au/.test(WEB + CONSOLE)) throw new Error('Refusing: that is production');

const targets = JSON.parse(open('./targets.json'));

// Peak requests a second per profile (section 3: views a month, console tabs, the 5 s poll), the poll at its top.
const RATES = {
  v1: { listing: 15, search: 5, console: 17, live: 100, webhook: 5 },
  v2: { listing: 35, search: 12, console: 33, live: 200, webhook: 10 },
  v3: { listing: 70, search: 25, console: 67, live: 400, webhook: 20 },
}[PROFILE];
if (!RATES) throw new Error(`PROFILE must be v1, v2 or v3, not ${PROFILE}`);

// Section 5 targets, p95 of the time to first byte; and under 1% errors.
const P95 = { listing: 200, search: 500, console: 800, live: 100, webhook: 1000 };

function scenario(kind, rate) {
  const exec = kind === 'console' ? 'consolePage' : kind;
  const vus = Math.ceil(rate * (MODE === 'spike' ? 10 : 1) * 2) + 5;
  if (MODE === 'smoke') return { executor: 'constant-arrival-rate', exec, rate: 1, timeUnit: '1s', duration: '30s', preAllocatedVUs: 2, maxVUs: 5 };
  if (MODE === 'spike') {
    return {
      executor: 'ramping-arrival-rate', exec, startRate: rate, timeUnit: '1s', preAllocatedVUs: vus, maxVUs: vus * 2,
      stages: [{ target: rate, duration: '5m' }, { target: rate * 10, duration: '30s' }, { target: rate * 10, duration: '5m' }, { target: rate, duration: '30s' }, { target: rate, duration: '5m' }],
    };
  }
  return { executor: 'constant-arrival-rate', exec, rate, timeUnit: '1s', duration: MODE === 'soak' ? '120m' : '60m', preAllocatedVUs: vus, maxVUs: vus * 2 };
}

const kinds = ['listing', 'search', ...(CONSOLE && COOKIE ? ['console', 'live'] : []), ...(WEBHOOK_SECRET ? ['webhook'] : [])];
export const options = {
  scenarios: Object.fromEntries(kinds.map((k) => [k, scenario(k, RATES[k])])),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    ...Object.fromEntries(kinds.map((k) => [`http_req_waiting{kind:${k}}`, [`p(95)<${P95[k]}`]])),
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const ok = (res, kind) => check(res, { [`${kind} 2xx`]: (r) => r.status >= 200 && r.status < 300 });

export function listing() {
  ok(http.get(`${WEB}/listing/${pick(targets.listings)}`, { tags: { kind: 'listing' } }), 'listing');
}

export function search() {
  ok(http.get(`${WEB}/search?q=${encodeURIComponent(pick(targets.suburbs))}`, { tags: { kind: 'search' } }), 'search');
}

const consoleHeaders = { cookie: COOKIE };
export function consolePage() {
  ok(http.get(`${CONSOLE}${pick(targets.consolePaths)}`, { headers: consoleHeaders, tags: { kind: 'console' }, redirects: 0 }), 'console');
}

export function live() {
  ok(http.get(`${CONSOLE}/api/live`, { headers: consoleHeaders, tags: { kind: 'live' } }), 'live');
}

// An event type the platform does not handle: signed, checked and answered 200 without touching Stripe or a job,
// so the webhook's path to its 200 is measured with every vendor faked.
export function webhook() {
  const body = JSON.stringify({ id: `evt_load_${__VU}_${__ITER}`, type: 'customer.created', data: { object: { id: 'cus_load' } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.hmac('sha256', WEBHOOK_SECRET, `${t}.${body}`, 'hex');
  ok(http.post(`${WEB}/api/stripe/webhook`, body, { headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, tags: { kind: 'webhook' } }), 'webhook');
}
