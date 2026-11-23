# 0098: Load shedding — polls give way to people

**Status:** proposed 2026-11-21 (V1-PERFORMANCE-PLAN step 2, PLATFORM-PLAN 4.3). Builds on 0097 (peak shaping) and
0094 (no pipelining: one statement per connection, the rest queue).

**Problem.** Each server instance has one pool (`DB_POOL_MAX`, default 5), and nothing bounds the wait for it. In the
2026-11-21 load run, past the knee every request queued until the client gave up at 10 s, and 80% failed at every
step. Half of the requests were polls and beacons:
- `/api/live` every 5 s per open console tab (41% of V1's traffic);
- the bell;
- the public site's activity beacon and presence ping.

They took the connections a person's page needed.

**Decision.** Two classes per server process.
- **Low priority.** `/api/live`, `/api/notifications` and `/api/activity` run through `withLowPriority`
  (`@repo/core/http/shed`).
  - At most 40% of the pool's connections run low-priority work at once: 2 of 5.
  - Past that, the route answers `503` with `Retry-After: 5` at once, without touching the database.
- **Everything else is never shed:** pages, user actions, webhooks, cron and health (which has its own pool, step 1).

The signal is the low-priority requests in flight in this process. It needs no driver internals, and a slow pool
keeps the slots full longer, so it sheds more exactly when the pool is slow.

**What the person sees.**
- The live stamp skips a tick: the page refreshes on the next one.
- The bell keeps what it showed: no empty bell, no repeated toasts.
- A shed beacon is a visit not counted: analytics, accepted.

**Not chosen.**
- Counting statements inside postgres.js: private queues, and the ADR 0094 patch sits there.
- A wait timeout on every query: it fails pages too.
- A shared limiter: the pool it protects is per instance.

**Proof.** Unit tests of the gate and the 503; a scan that the three routes use it and no page does. The spike run of
PLATFORM-PLAN 4.3 must show pages and webhooks ≥ 99.9% while polls shed. The load report has to count a shed 503
on these routes as shed, not as a failure (load tooling, `test/4.3-load-judged`).
