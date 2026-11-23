// Self-check for catalog.js (no network): node load/catalog.test.mjs
import assert from 'node:assert/strict';
import { ENDPOINTS, TARGETS, VERSIONS, population, stepFractions, stepStages } from './catalog.js';
import { judgeValidity, stepTable } from './judge.mjs';

// Versions are section 3's numbers; pop with nothing set is V1; a number given wins over the version.
assert.deepEqual(population({ PROFILE: 'v2' }).agencies, VERSIONS.v2.agencies);
assert.equal(population({ PROFILE: 'v2' }).agents, VERSIONS.v2.agents - VERSIONS.v2.agencies);
assert.equal(population({}).agencies, 200);
assert.equal(population({ PROFILE: 'v2', AGENCIES: '3' }).agencies, 3);

// The webhook follows the agencies: section 3's 5 / ~10 / ~20 a second.
const hook = ENDPOINTS.find((e) => e.kind === 'system_stripe_webhook');
assert.equal(hook.perMin(population({ PROFILE: 'v1' })) / 60, 5);
assert.equal(hook.perMin(population({ PROFILE: 'pop', AGENCIES: '2' })), 3);

// Steps: a climb and a hold per fraction; bad fractions refused.
assert.deepEqual(stepStages(100, { STEPS: '0.1,1', STEP: '1m' }), [
  { target: 10, duration: '30s' }, { target: 10, duration: '1m' }, { target: 100, duration: '30s' }, { target: 100, duration: '1m' },
]);
assert.equal(stepStages(10, { STEPS: '0.01' })[0].target, 1);
assert.throws(() => stepFractions({ STEPS: '0.5,x' }));

// Every target names requests that exist.
for (const t of TARGETS) for (const k of t.kinds ?? []) assert.ok(ENDPOINTS.some((e) => e.kind === k), k);

// A run is valid only near the database, with k6 keeping up and not starved of CPU.
const good = { rttMs: 2, dropped: 0, k6CpuPeakPct: 40, cores: 8, sameMachine: false, generatorErrors: 0, redirects: 0 };
assert.equal(judgeValidity(good).valid, true);
assert.equal(judgeValidity({ ...good, rttMs: 300 }).valid, false);
assert.equal(judgeValidity({ ...good, dropped: 5 }).valid, false);
assert.equal(judgeValidity({ ...good, k6CpuPeakPct: 700 }).valid, false); // 700% of 8 cores = 88%
assert.equal(judgeValidity({ ...good, otherTrafficPerSec: 4.2 }).valid, false);
assert.equal(judgeValidity({ ...good, otherTrafficPerSec: 0.3 }).valid, true);
assert.equal(judgeValidity({ ...good, sameMachine: true }).checks.find((c) => c.name.startsWith('k6 apart')).ok, false);

// Step table: the knee is the first step over 1% failures or over budget.
const steps = stepTable(
  [{ from: 0, to: 10, offered: 5 }, { from: 10, to: 20, offered: 10 }, { from: 20, to: 30, offered: 20 }],
  [{ t: 2, ok: true, ms: 50, overBudget: false }, { t: 12, ok: true, ms: 60, overBudget: false }, { t: 13, ok: true, ms: 70, overBudget: false },
    { t: 22, ok: false, ms: 9000, overBudget: true }, { t: 23, ok: true, ms: 80, overBudget: false }],
);
assert.equal(steps.knee, 2);
assert.equal(steps.rows[1].errPct, 0);
assert.equal(steps.rows[2].errPct, 50);
// Each road to the knee alone: failures with every request in budget, and slowness with none failing.
const two = [{ from: 0, to: 10, offered: 1 }, { from: 10, to: 20, offered: 2 }];
assert.equal(stepTable(two, [{ t: 1, ok: true }, { t: 11, ok: false }, { t: 12, ok: true }, { t: 11, ms: 5, overBudget: false }]).knee, 1);
assert.equal(stepTable(two, [{ t: 1, ok: true }, { t: 11, ok: true }, { t: 11, ms: 900, overBudget: true }]).knee, 1);
assert.equal(stepTable(two, [{ t: 1, ok: true }, { t: 11, ok: true }, { t: 11, ms: 5, overBudget: false }]).knee, null);
console.log('catalog and judge: ok');
