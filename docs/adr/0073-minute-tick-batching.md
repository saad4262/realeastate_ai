# 0073 — The minute tick runs its jobs in rounds against a time budget

**Status:** accepted, 2026-10-30 (the user: make `/api/cron/minute` scale safely for 50–100 agencies).
No migration.

**Context.** `/api/cron/minute` called eight jobs one after another, each once, with fixed batches
(workflow events 50, scheduled actions 10, platform emails 100, AI calls 5…), inside `maxDuration = 60`.
With 50–100 agencies: a queue bigger than one batch waited a minute per batch (10 approved sends a minute
is 600 an hour, whatever the backlog); a slow job could eat the minute so the later jobs (emails, AI
calls) never ran; and nothing stopped the tick starting work it could not finish before Vercel killed it.
The workflow tick also re-ran its every-agency scans on every call.

**Decision.**
1. **A runner in core** (`packages/core/src/cron/tick.ts`, pure, clock injected). Pass 1 gives every job
   one round in order — no job starves another. Pass 2 spends what is left on the "drain" jobs whose last
   batch came back full, round-robin, until their queues are empty or the budget is spent. A round is not
   started unless the time left is at least that job's slowest round so far (floor 2 s). A job that throws
   stops for this tick; the others go on. The report gives each job's rounds, time, totals, `more`, and
   `skipped` / `error`.
2. **The job list is core's too** (`cron/minute-jobs.ts`; non-negotiable 10): order by how much the time
   matters — workflows (their first steps fall due in the same tick), scheduled actions, reminders, AI
   calls, platform emails, then Zoom alerts, deal sync, Twilio business checks. Drain: workflows,
   scheduled actions (2 workers), reminders, AI calls (batch now 10), platform emails. Once: Zoom alerts,
   deal sync (set-based), KYC (every 5 minutes; each account is asked hourly anyway). The workflow tick
   scans only in its first round (`scans: false` after).
3. **Budget 45 s** of the 60 s: the rest is headroom for the round in flight. Parallel workers and
   overlapping ticks are safe because every job already claims its rows itself (`FOR UPDATE SKIP LOCKED`
   or a guarded update) — no new lock. The route only builds dependencies from env and calls `runTick`.

**Consequences.** Throughput now follows the backlog instead of a fixed batch; a stuck provider costs one
job's rounds, not the tick. The cron log's shape changed: `{ ok, ms, budgetMs, jobs: { name: { rounds,
ms, more, result, … } } }`. Verified by unit tests (fairness, draining, deadline, isolation, minute
filter, parallel workers); NOT run against the shared database, which production's cron also uses.

**Not done.** Per-agency fairness inside one queue (each queue is first-due-first); the 5-minute
`/api/cron/alerts` tick; a pool larger than 10 connections.
