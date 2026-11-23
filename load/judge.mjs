// PLATFORM-PLAN 4.3: the two judgements report.mjs makes before it grades the platform. Pure; checked by catalog.test.mjs.

/**
 * Was this run a test of the platform at all? A run far from the database, or one where k6 could not send what it
 * was asked (dropped iterations, a starved or crowded machine), measures the setup: the report then says so first
 * and grades nothing (k6 docs, "Running large tests": keep the generator under 80% CPU, apart from the target).
 */
export function judgeValidity({ rttMs, dropped, k6CpuPeakPct, cores, sameMachine, generatorErrors, redirects, otherTrafficPerSec = null }) {
  const machinePct = k6CpuPeakPct === null || k6CpuPeakPct === undefined ? null : k6CpuPeakPct / Math.max(1, cores);
  const checks = [
    { name: 'servers next to the database (round trip ≤ 5 ms)', ok: rttMs !== null && rttMs !== undefined && rttMs <= 5,
      got: rttMs === null || rttMs === undefined ? 'not measured' : `${rttMs.toFixed(0)} ms` },
    { name: 'k6 sent everything it was asked (no dropped iterations)', ok: dropped === 0, got: `${dropped.toLocaleString()} dropped` },
    { name: "k6's machine under 80% CPU", ok: machinePct === null || machinePct < 80,
      got: machinePct === null ? 'not measured' : `${machinePct.toFixed(0)}% of ${cores} cores` },
    { name: 'k6 apart from the servers it tests', ok: !sameMachine, got: sameMachine ? 'same machine' : 'apart' },
    { name: 'no load-generator errors (open files, ports)', ok: generatorErrors === 0, got: `${generatorErrors}` },
    { name: 'sessions held (no sign-in redirects)', ok: redirects === 0, got: `${redirects.toLocaleString()} redirects` },
    // Someone else's run on the same database adds load and makes the profile's statement counts guesses.
    { name: 'database quiet before the run (other traffic < 2 statements/s)', ok: otherTrafficPerSec === null || otherTrafficPerSec < 2,
      got: otherTrafficPerSec === null ? 'not measured' : `${otherTrafficPerSec.toFixed(1)}/s` },
  ];
  return { valid: checks.every((c) => c.ok), checks };
}

/**
 * MODE=step: each step graded on its own. `steps` are [{ from, to, offered }] in seconds from the start (offered =
 * requests a second asked for); `reqs` are outcomes { t, ok } and timings { t, ms, overBudget } (k6 writes them as
 * separate rows; one object may carry both). The knee is the first step with more than 1% failures or more than 5%
 * of requests over their budget (its p95 is over budget).
 */
export function stepTable(steps, reqs) {
  const rows = steps.map((s) => {
    const inStep = reqs.filter((r) => r.t >= s.from && r.t < s.to);
    const outcomes = inStep.filter((r) => r.ok !== undefined);
    const timings = inStep.filter((r) => r.ms !== undefined);
    const n = outcomes.length;
    const bad = outcomes.filter((r) => !r.ok).length;
    const over = timings.filter((r) => r.overBudget).length;
    const ms = timings.map((r) => r.ms).sort((a, b) => a - b);
    return {
      offered: s.offered, achieved: n / Math.max(1, s.to - s.from), sent: n,
      errPct: n ? (bad / n) * 100 : 0, overBudgetPct: timings.length ? (over / timings.length) * 100 : 0,
      p50: ms.length ? ms[Math.floor(ms.length * 0.5)] : null, p95: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null,
    };
  });
  const k = rows.findIndex((r) => r.sent > 0 && (r.errPct > 1 || r.overBudgetPct > 5));
  return { rows, knee: k === -1 ? null : k };
}
