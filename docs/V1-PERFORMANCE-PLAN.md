# V1 performance plan

Written 2026-11-21 for the Claude Code sessions that carry it out, step by step, in order. Every "go" is the owner's.
Tracker: `V1-IMPLEMENTATION-STATUS.md` (4.3 stays **Built** until step 15 passes; the count stays 52/80 until then).
Load tooling: branch `test/4.3-load-judged` (`load/`; README "How a run is judged", "A free machine in Sydney").

## Goal
V1 carries section 3's V1 population (200 agencies, 500 agents, 2,000 users ≈ **244 requests/s at peak**, from
`load/catalog.js`) and meets PLATFORM-PLAN section 5:

| Target | p95 |
|---|---|
| Public listing page, first byte | < 200 ms |
| Public search | < 500 ms |
| Console page | < 800 ms |
| `/api/live` | < 100 ms |
| Webhook 200 | < 1 s |
| Success | **99.99%** at normal load |
| `after-run.sql` | all 0 |

Headroom toward V2 (≈ 542 req/s) is part of the goal.

## What we know (2026-11-21)
- **Two laptop runs**, `load/runs/20261121-133937` and `load/runs/20261121-144026`:
  - k6 and both apps on a laptop in Pakistan, with the dev DB in Sydney;
  - 52,344 requests in the second run;
  - 78.7% failed, knee at ~3 req/s;
  - the report marked both **not valid**.
- **The setup was the main cause.** The DB round trip was 307 ms, so 5 connections ÷ 0.307 s ≈ 16 statements/s per
  app.
- **Requests that do not touch the DB passed at every step:** ISR pages, search, webhook, mail sync. p95 was 21–63 ms.
  Every request that touches the DB failed from the first step, `/api/health` included.
- **DB execution time is small**, measured with `pg_stat_statements` on dev (~20k rows):

  | Query | Mean time |
  |---|---|
  | Actor query | 0.15 ms |
  | `site_activity` insert | 0.4 ms |
  | Public search (`searchPublicListings`, ISR-cached 30 s) | 12 ms |
  | Listing-activity counts | **96 ms** |
  | Admin `siteTrend` | **115 ms** |

- **No data was harmed.** `after-run.sql` was all 0: no duplicate texts or charges, no lost webhooks, no dead jobs.
- **Another client holds transactions open on dev.** Backends stayed `active`/`ClientRead` with the transaction open
  for up to 1,020 s. The query was a listing select through Supavisor.
- **Theory, until step 13 proves it.** On Vercel `syd1` beside the DB (1–2 ms), V1 fits even with today's code (est.
  500–700 req/s of the V1 mix). Steps 1–8 are for:
  - spikes and 99.99% success under overload;
  - V2/V3 headroom;
  - DB cost.

## Rules (from the owner; never bend them)
- **Environments.**
  - Dev first. **Never touch production** without the owner's explicit go: no merge to `main`, no migration, no
    setting change.
  - `.env.local` and `.env.dev` are dev.
- **Git.**
  - One step, one branch, one worktree from `origin/main`.
  - Never work in `/Users/saadiii/Job/realestate_ai`: parallel sessions use it.
  - Never force-push.
  - Never `git checkout` over uncommitted work.
- **Secrets and AI.**
  - Never print or commit secrets.
  - No live LLM calls in tests.
  - Smoke runs only small named groups.
- **Dev data.** Synthetic data on dev stays ≤ ~20k rows. More needs the owner to raise dev's disk first.
- **House rules (CLAUDE.md, ARCHITECTURE.md).**
  - `can()` decides permissions.
  - Multi-step writes go in `db.transaction`.
  - Business logic lives in `packages/core`.
  - A big decision gets an ADR first.
- **Reporting.** Report to the owner in Roman Urdu, with the straight count (52/80).

## Status (2026-11-21)
| Step | Branch | Result |
|---|---|---|
| 1 | `perf/1-health-own-pool` | Built |
| 2 | `perf/2-load-shedding` (on 1) | Built; ADR 0098 accepted by the owner |
| 3 | `perf/3-live-one-statement` (on 2) | Built; `/api/live` 2 statements, not 1 (the stamp's scope is `can()`'s) |
| 4 | `perf/4-actor-badges-split` (on 3) | Built |
| 5 | `perf/5-waterfalls` (on 4) | Built |
| 6 | `perf/6-no-write-on-read` | Built |
| 7 | `perf/7-slow-queries` | Built; migration 0107 (index) |
| 8 | — | Finding, no code: `statement_timeout` per connection is ignored by Supavisor's transaction pooler; the server default (2 min) bounds statements today; owner: stays 2 min for V1; a request-traffic DB role is V2 |
| 9 | `perf/9-clientread-alert` | Built; production checked (owner's go): nothing stuck |

## How Claude finishes every code step (1–9)
1. `git worktree add -b <branch> /Users/saadiii/Job/realestate_ai-<short> origin/main`. Steps 1–4 touch the same
   files (`packages/db/src/client.ts`, `/api/live`, `load-actor.ts`), so they stack instead: 2 on 1, 3 on 2, 4 on 3,
   5 on 4 (it needs the actor's statement). Steps 6, 7 and 9 start from `origin/main`.
2. Read the files named in the step and every caller of what you change (grep) before editing.
3. Make the change. Add or extend the test named in the step. Read paths keep or lower their statement count:
   `packages/core/src/listings/query-count.test.ts` or a sibling.
4. **Break-test:** undo the fix (or break what the check guards), watch the test go red, then restore it.
5. `pnpm typecheck`, `pnpm lint` and `pnpm test` must be green. Run the smoke group only if the step names one.
6. Commit, then push the branch. **Do not merge.**
7. Add a Log row to `docs/V1-IMPLEMENTATION-STATUS.md` on branch `docs/platform-plan` (worktree
   `/Users/saadiii/Job/realestate_ai-docs`; the copy on `main` is stale): date, step, branch and commit, result.
8. Tell the owner in Roman Urdu: what changed, the proof, the branch, and what was not checked.

## The steps

### Step 1. Health check off the shared queue
- **Who:** Claude.
- **Why.** `/api/health` waits in the same 5-connection pool as every page. Under load it failed 96–99%, so an uptime
  monitor would call a busy site "down".
- **Claude does:**
  1. Read `apps/web/app/api/health/route.ts`, `apps/console/app/api/health/route.ts`, and `packages/db/src/client.ts`
     (`getDb` keeps one pool per connection string).
  2. Give health its own 1-connection pool. For example, the same URL with `application_name=health`, which `getDb`
     keys separately.
  3. Bound the check at ~2 s. A slow DB answers `503 db_slow` instead of hanging.
  4. Test: hold the main pool busy, and health still answers within 2 s.
  5. Break-test: point health back at the shared pool and watch it go red.
- **Done when** health answers in < 2 s while the main pool is saturated.

### Step 2. Load shedding: fail fast for low-priority requests
- **Who:** Claude. The ADR is shown to the owner with the branch.
- **Why.** Nothing limits the wait for a connection. Requests queue until the client's 10 s timeout, so past the knee
  everything fails (80% at every step above 25%).
- **Claude does:**
  1. Read ADR 0097 (peak shaping) and ADR 0094 (no pipelining through Supavisor).
  2. Write `docs/adr/NNNN-load-shedding.md` (10 lines). It sets:
     - the priority classes: webhooks > user actions > pages > polls and beacons;
     - the signal: in-flight statements per pool;
     - the threshold.
  3. In `packages/db/src/client.ts`, count in-flight statements per pool (cheap; no extra round trip).
  4. In `apps/console/app/api/live/route.ts`, `apps/console/app/api/notifications/route.ts` and
     `apps/web/app/api/activity/route.ts`: past the threshold, return `503` with `Retry-After` at once.
  5. In `apps/console/components/live-refresh.tsx`, a 503 skips that tick quietly.
  6. Tests:
     - the threshold function;
     - a route returns 503 when busy;
     - pages are never shed.
  7. Break-test: set the threshold to infinity and watch it go red.
- **Done when** a saturated pool sheds polls in < 50 ms and pages still get connections.

### Step 3. `/api/live`: one light statement
- **Who:** Claude.
- **Why.** At V1 this is 100 req/s, 41% of all traffic. Each poll runs 3 serial statements, and the first carries 7
  count sub-queries the route throws away:
  - `loadListingActor` → `loadActorContext` (`apps/console/lib/load-actor.ts`);
  - then `listing_agent`;
  - then `consoleLiveStamp` (`packages/core/src/mail/live.ts`).
- **Claude does:**
  1. Write one SQL statement that reads:
     - the membership: agency, role, status, removed, agency status;
     - the listing links, with `array_agg`;
     - the stamp parts.

     No badges.
  2. Build the actor from that row, so `can()` still decides the mail scope (`threadScopeFilters`).
  3. Keep last-seen at most once a minute.
  4. Tests:
     - query count = 1 (+1 a minute for last-seen);
     - the stamp equals the old one on the same fixtures;
     - a blocked member gets no stamp.
  5. Break-test: restore the old path and watch the count test go red.
- **Done when** `/api/live` is one statement with the same answers.

### Step 4. Split the actor (permissions) from the badges (chrome)
- **Who:** Claude.
- **Why.** The 7-count actor query runs on every page, every bell and every poll. Only the console header shows the
  counts.
- **Claude does:**
  1. Read:
     - `apps/console/lib/load-actor.ts`;
     - `apps/console/lib/require-console-access.ts` (`loadConsoleChrome`, `requireConsoleAccess`);
     - `apps/console/app/api/notifications/route.ts`.
  2. `loadActor` reads membership, agency status, sends-paused and user name only.
  3. The badges become a separate single statement used only by `loadConsoleChrome`.
  4. Keep the following behaviour exactly as today:
     - `blocked` (ADR 0050);
     - `mfaMark` (1.3);
     - `sendsPaused` and `mayResume` (3.7);
     - offers zeroed by `can()`.
  5. Tests:
     - permission tests unchanged and green;
     - the bell's statement count drops;
     - the header shows the same numbers.
- **Done when** no API route runs the badge sub-queries.

### Step 5. Waterfalls into one round trip
- **Who:** Claude.
- **Why.** Independent reads are awaited one after another. Each `await` is a round trip, and holds a pool connection
  longer.
- **Claude does:**
  1. `apps/console/components/deals/finance-page.tsx`: actor → listing links → `agencyTimeZone` → report. Fold the
     links and the timezone into existing statements, or run them with `Promise.all`.
  2. `apps/console/app/(agent)/listings/page.tsx`: list → `matchingBuyerCounts`. Fold the counts into the list, or
     run them in parallel where they do not depend on the list.
  3. `apps/web/app/account/*/page.tsx`: `isUserBlocked` → upsert → threads → guide threads. Run the independent ones
     in parallel; step 6 removes the upsert.
  4. Grep for other pages with two sequential independent `await`s on the DB, and list them in the commit.
  5. Tests: a query count per changed page.
- **Done when** no changed page awaits two independent reads one after another.

### Step 6. No write on a read
- **Who:** Claude.
- **Why.** Every buyer account page runs `ensureConsumerAccount` → `ensureAppUser` → `INSERT … ON CONFLICT DO
  UPDATE SET updated_at = now()`. That is a row lock, a new tuple and WAL on every page view.
- **Claude does:**
  1. Read `apps/web/lib/account.ts`, `packages/core/src/identity/ensure-app-user.ts` and every caller.
  2. Add `WHERE (email, name, phone, avatar_url) IS DISTINCT FROM (excluded…)`, keeping the `coalesce` rules, so
     an unchanged account writes nothing.
  3. Test: a second call with unchanged data updates 0 rows, and a changed email still updates.
  4. Break-test: drop the `WHERE` and watch it go red.
- **Done when** a repeat page view writes nothing.

### Step 7. The slow queries
- **Who:** Claude. A production index needs the owner's go in step 19.
- **Claude does:**
  1. `EXPLAIN (ANALYZE, BUFFERS)` on dev for each:
     - listing-activity counts, 96 ms (`packages/core/src/activity/scope.ts` and its callers);
     - admin `siteTrend`, 115 ms (`packages/core/src/platform/site-users.ts:354`);
     - agent listings, 12 ms;
     - suburb aggregate, 13 ms.
  2. Add indexes through `packages/db/src/concurrent-indexes.ts` (built concurrently). Use counters only where an
     index cannot do it.
  3. Put the before and after plans in the commit message. Check with `pnpm --filter @repo/db db:slow-queries`.
- **Done when** each is < 20 ms on dev, or the reason it cannot be is written down.

### Step 8. `statement_timeout` per kind of work (tracker 1.8 part 2)
- **Who:** Claude.
- **Why.** A stuck or runaway statement holds a connection indefinitely.
- **Claude does:**
  1. Read ADR 0094 first. The pool runs with `max_pipeline: 0` and a postgres.js patch, and an earlier patch
     deadlocked the production cron.
  2. Set the timeout on the connection, per pool or role: requests ~5 s, cron and jobs longer.
  3. Test pools of size 1, 2 and 5, direct and through the pooler, with a transaction mixed in.
  4. Test: `pg_sleep` past the limit is cancelled.
- **Done when** no request statement can outlive its limit.

### Step 9. Watch for stuck transactions
- **Who:** Claude. The production check needs the owner's go.
- **Claude does:**
  1. Add to `/api/health/alerts` a count of backends `state = 'active' AND wait_event = 'ClientRead' AND now() -
     xact_start > interval '60 seconds'`. Today's watch only sees `idle in transaction`.
  2. Break-test it on dev with a client that stalls mid-statement.
  3. **After the owner's go:** run one read-only query on production for the same pattern. Report it, change
     nothing.
  4. On dev, read `client_addr` and `application_name` of the stuck backends, and ask the owner whose they are.
- **Done when** the alert exists and the production answer is reported.

### Step 10. A machine in Sydney
- **Who:** the owner creates it; Claude sets it up. The owner can do this any time during steps 1–9.
- **Owner does:**
  1. A new AWS account on the **Free plan**.
  2. Region `ap-southeast-2` → EC2: Ubuntu 24.04, `m7i-flex.large`, 20 GB, SSH from the owner's IP only.
  3. Gives Claude the IP and the path of the SSH key, never the key's contents.
- **Claude does:**
  1. On the VM: `load/vm-setup.sh`.
  2. `scp` `.env.dev` (never git).
  3. Log in again, then check `k6 version`, `node -v`, and `psql "$DIRECT_URL" -c 'select 1'`.
- **Done when** the VM reaches the dev DB in ≤ 5 ms (`load/profile.mjs` prints the round trip).

### Step 11. Previews, firewall and settings
- **Who:** the owner. Claude checks the result.
- **Owner does:**
  1. Vercel previews of all four projects pointed at dev, every vendor stubbed (README "The day", step 3).
  2. A Firewall **System Bypass** rule for the VM's IP; the bypass secret to Claude as `VERCEL_BYPASS`; Attack Mode
     off.
  3. Dev compute and pooler pool size as production (tracker 1.9, 1.19). Optional: a pass on smaller compute still
     counts.
  4. Nobody else on the dev DB during the runs.
- **Claude does:**
  1. Seed V1 from the VM within the 20k-row rule, then `node load/targets.mjs`.
  2. `node load/sessions.mjs`.
- **Done when** the previews answer the VM with no 403 or 429.

### Step 12. Smoke from Sydney
- **Who:** Claude.
- **First, on `test/4.3-load-judged`:** k6 and `load/report.mjs` count a `503` with `Retry-After` on `/api/live`,
  `/api/notifications` and `/api/activity` as **shed**, not failed (ADR 0098). Give it its own column, and keep
  shed out of the error rate.
- **Claude does:** `load/run.sh -e MODE=smoke` with the preview URLs (`-e WEB=… -e AGENTS_URL=… -e AGENCY_URL=…
  -e ADMIN_URL=…`) and `-e STRIPE_WEBHOOK_SECRET=whsec_load_test`.
- **Done when** there are 0 errors and the report's validity block is all green.

### Step 13. Step test at V1
- **Who:** Claude.
- **Claude does:**
  1. Fresh sessions.
  2. `load/run.sh -e MODE=step -e PROFILE=v1 …` (~90k requests, ~17 min).
  3. Bring the run folder back with `scp`, and report the steps table.
- **Done when** every step has ≤ 1% errors, the section 5 p95s hold, and no knee is found. If not, go to step 17.

### Step 14. Step test at V2
- **Who:** Claude.
- **Claude does:** `-e MODE=step -e PROFILE=v2`. V2-sized data needs the owner to raise dev's disk first. Without it,
  run V2 rates on V1 data and say so.
- **Done when** the knee is found and V1's rate sits at ≤ 50% of it.

### Step 15. Long runs
- **Who:** Claude.
- **Claude does**, each with fresh sessions and a report:

  | Run | Command | Pass |
  |---|---|---|
  | Load V2 | `-e MODE=load -e PROFILE=v2` (60 min) | Section 5 holds; **99.99% success** |
  | Spike | `-e MODE=spike -e PROFILE=v2` (10× for 5 min) | Pages and webhooks ≥ 99.9%; polls may shed (step 2); back to normal within 2 min |
  | Soak | `-e MODE=soak -e PROFILE=v1` (2 h) | No memory growth; p95 does not drift |

- **Done when** all three pass.

### Step 16. Recovery drills
- **Who:** Claude. The owner is told before each one.
- **Claude does**, during a `MODE=load` run (README "The day", step 6):
  1. Cut the pooler for a minute.
  2. Point the SMS vendor at a black hole.
  3. Kill a tick mid-batch.
- **Done when** errors return to normal within 2 minutes without a redeploy, and `after-run.sql` is all 0.

### Step 17. When a run fails: read the knee, fix, re-run
- **Who:** Claude.
- **Claude does:** match the report to the row below, fix one cause on its own branch (the code-step routine), re-run
  the same step, and compare in the report's "Against the run before" block.

  | The report shows | Cause | Fix |
  |---|---|---|
  | DB CPU high, slow queries on top | Heavy statements | Step 7 on the named query, or the compute size (owner) |
  | Pooler "max client connections" | Instances × `DB_POOL_MAX` over the pooler's clients | Lower `DB_POOL_MAX`, or a bigger compute (owner) |
  | Pool wait high, DB CPU low | Too many statements per request | Steps 3–5 on the busiest request |
  | Function 5xx, server CPU high | Rendering cost | Profile the page; cache what can be cached |
  | 403/429 from Vercel | Firewall | Fix the bypass and re-run (not a platform result) |
  | `ClientRead` backends grow | A stalled client or pooler | Step 9; ADR 0094 settings |

### Step 18. Clean up after the runs
- **Who:** Claude and the owner.
- **Claude does:**
  1. `node load/sessions.mjs --delete`.
  2. `psql "$DIRECT_URL" -f load/cleanup.sql`.
  3. Delete `.env.dev` from the VM.
- **Owner does:**
  1. Stop the VM.
  2. Lower dev's compute.
  3. Rotate the bypass secret.
  4. Remove the firewall rule.

### Step 19. Production
- **Who:** Claude carries it out, **only after the owner's go**.
- **Claude does:**
  1. Merge the code steps' branches into one `integrate/v1-performance` branch. In a clean worktree: typecheck,
     lint, tests and builds.
  2. If an index or migration is included:
     - a production backup, verified;
     - then apply from a checkout whose journal ends at it (the procedure in the tracker's Log).
  3. Merge into `main` with `--no-ff`, then push.
  4. Check:
     - Vercel success on all four projects;
     - `/api/health` ok on all four;
     - the `/ai` redirect and the login page unchanged.
  5. Watch for 10 minutes:
     - 5xx;
     - p95;
     - pool waits;
     - `idle in transaction` **and** `active/ClientRead`.
- **Done when** production is live and quiet.

### Step 20. Close out
- **Who:** Claude.
- **Claude does:**
  1. Tracker row 4.3 → **Done**, with the date, the p95s, the success rate and the after-run counts.
  2. A Log row.
  3. Report the new count straight.
  4. Write the V2 items below into the tracker as V2 work.

## Not built for V1 (V2/V3, written down only)
- A `live_stamp` version row bumped on writes. The poll becomes a primary-key lookup.
- Beacon batching.
- Badge counter tables.
- A read replica for admin and insights.
- Realtime push instead of polling (V3).
- `site_activity` partitions (V3).
- A separate database role for request traffic with its own `statement_timeout` (owner, step 8): the pooler ignores
  per-connection settings, and a role-level limit on `postgres` would also bound cron and migrations.

## Owner actions that block launch (outside this plan)
| Area | Tasks |
|---|---|
| Rate limit and bot protection | Shared rate limiter 1.4 (Upstash, O-15); firewall and Turnstile 1.5 (O-16) |
| Backups and recovery | 0.4, 0.8 (O-6–O-9); PITR 0.3 (Decision 7); restore drill 4.4 (O-19); rollback drill 4.8 |
| Monitoring | Sentry 0.7 (O-13); uptime monitor 1.14 |
| Email, domains, sender ID | SMTP 0.10; DNS and email 5.5, 5.6 (O-22); ACMA 5.7 |
| Legal | 5.1, 5.2, 5.11 (lawyer, O-21) |
| Accounts | Business accounts 5.9; status page 5.10 |

Full list: `V1-OWNER-ACTIONS.md`.

## Expected numbers (theory; steps 13–15 replace them)
| | Capacity (V1 mix) | `/api/live` p95 | Console page p95 |
|---|---|---|---|
| Laptop run (measured) | ~3 req/s | 10 s (timeout) | 10 s (timeout) |
| Sydney, today's code | ~500–700 req/s | ~20–40 ms | ~200–400 ms |
| Sydney + steps 1–6 | ~700–900 req/s | ~10–20 ms | ~150–300 ms |
| + step 7 | ~1,200–1,500 req/s | same | lower on the heavy pages |

Assumptions:
- ~2 DB cores at 70%;
- 15 pooler backends;
- 1–2 ms round trip;
- dev-sized data.

V2-sized data (2.5M contacts) can make the count queries 10–50× slower. That is the largest unknown, and step 14
answers it.
