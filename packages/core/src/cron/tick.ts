/**
 * A time-budgeted tick runner (ADR 0073): one cron request, many jobs, a deadline.
 *
 * Pass 1 gives EVERY job one round, in order, so a busy job never starves the ones after it. Pass 2
 * spends what is left on the "drain" jobs whose last batch came back full, round-robin, until their
 * queues are empty or the budget is spent. A round is not started when it would likely run past the
 * deadline (its job's slowest round so far, or a floor). A job that throws stops for this tick; the
 * others carry on. Every job's claims are row-safe (SKIP LOCKED / guarded updates), so a drain job may
 * run several workers at once, and an overlapping tick never does a row twice.
 *
 * Pure: the clock is injected; no database, no network.
 */

export type TickResult = Record<string, unknown>;

export type TickJob = {
  name: string;
  /** once: one round per tick. drain: more rounds while the batch came back full and time is left. */
  mode: 'once' | 'drain';
  /** Run only on minutes divisible by this (UTC minute of the hour); default every minute. */
  everyMinutes?: number;
  /** Parallel workers per round for a drain job (its claims are row-safe). Default 1. */
  concurrency?: number;
  /** One batch. `more`: it was full, so there is probably more waiting. */
  run: (round: number) => Promise<{ result: TickResult; more: boolean }>;
};

export type TickJobReport = {
  rounds: number;
  ms: number;
  /** Still had work when the tick ended. */
  more: boolean;
  skipped?: 'not_this_minute' | 'out_of_time';
  error?: string;
  /** The rounds' results, numbers summed; anything else is the last round's. */
  result: TickResult;
};

export type TickReport = { ms: number; budgetMs: number; jobs: Record<string, TickJobReport> };

/** Never start a round with less than this left, whatever the job's history. */
export const MIN_ROUND_MS = 2_000;

function merge(into: TickResult, add: TickResult): TickResult {
  for (const [k, v] of Object.entries(add)) {
    const cur = into[k];
    into[k] = typeof v === 'number' && typeof cur === 'number' ? cur + v : v;
  }
  return into;
}

export async function runTick(jobs: readonly TickJob[], opts: { budgetMs: number; clock?: () => number; minute?: number }): Promise<TickReport> {
  const clock = opts.clock ?? Date.now;
  const start = clock();
  const deadline = start + opts.budgetMs;
  const minute = opts.minute ?? new Date(start).getUTCMinutes();
  const reports: Record<string, TickJobReport> = {};
  const slowest = new Map<string, number>();

  const roundOf = async (job: TickJob): Promise<void> => {
    const r = reports[job.name]!;
    const workers = job.mode === 'drain' ? Math.max(1, job.concurrency ?? 1) : 1;
    const t0 = clock();
    try {
      const outs = await Promise.all(Array.from({ length: workers }, () => job.run(r.rounds)));
      r.rounds += 1;
      for (const o of outs) merge(r.result, o.result);
      // More only if every worker came back full: one short batch means the queue ran dry.
      r.more = job.mode === 'drain' && outs.every((o) => o.more);
    } catch (err) {
      r.rounds += 1;
      r.more = false;
      r.error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
    const took = clock() - t0;
    r.ms += took;
    slowest.set(job.name, Math.max(slowest.get(job.name) ?? 0, took));
  };

  const fits = (job: TickJob) => deadline - clock() >= Math.max(MIN_ROUND_MS, slowest.get(job.name) ?? 0);

  // Pass 1: every job due this minute gets one round.
  for (const job of jobs) {
    reports[job.name] = { rounds: 0, ms: 0, more: false, result: {} };
    const every = Math.max(1, job.everyMinutes ?? 1);
    if (minute % every !== 0) {
      reports[job.name]!.skipped = 'not_this_minute';
      continue;
    }
    if (!fits(job)) {
      reports[job.name]!.skipped = 'out_of_time';
      continue;
    }
    await roundOf(job);
  }

  // Pass 2: drain what is left, round-robin, while time allows.
  for (;;) {
    const waiting = jobs.filter((j) => j.mode === 'drain' && reports[j.name]!.more && !reports[j.name]!.error && fits(j));
    if (!waiting.length) break;
    for (const job of waiting) {
      if (!fits(job)) continue;
      await roundOf(job);
    }
  }

  return { ms: clock() - start, budgetMs: opts.budgetMs, jobs: reports };
}
