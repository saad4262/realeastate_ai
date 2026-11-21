# V1 performance plan: from a failed laptop load test to a graded pass in Sydney

Written 2026-11-21 for Claude Code sessions that will carry it out. Owner of every "go": the project owner.
Tracker: `V1-IMPLEMENTATION-STATUS.md` (task 4.3 stays **Built** until Phase 4 passes; the count stays 52/80 until then).
Load tooling: branch `test/4.3-load-judged` (`load/`, README "How a run is judged" and "A free machine in Sydney").

## 0. Read this first

### The goal
V1 carries **section 3's V1 population** (200 agencies, 500 agents, 2,000 users ≈ **244 requests/s at peak**, see
`load/catalog.js`) and meets **PLATFORM-PLAN section 5**:

| Target | p95 |
|---|---|
| Public listing page, first byte | < 200 ms |
| Public search | < 500 ms |
| Console page | < 800 ms |
| `/api/live` | < 100 ms |
| Webhook 200 | < 1 s |
| Errors | < 1% (SLO: **99.99% request success** at normal load) |
| `after-run.sql` | all 0 |

Section 3 also sizes V2 (≈ 542 req/s) and V3 (≈ 1,082 req/s). V1 must show headroom toward V2.

### What we know (evidence, 2026-11-21)
| Run | Where | Result | Meaning |
|---|---|---|---|
| `load/runs/20261121-133937` | k6 + both apps on a laptop in Pakistan, dev DB in Sydney | 23% failed, not valid | Setup only |
| `load/runs/20261121-144026` | Same, 52,344 requests, 4 → 40 req/s | 78.7% failed, knee at ~3 req/s, **not valid** | Setup only, but the pattern below is real |

- **The setup was the main cause.** The DB round trip was 307 ms. 5 connections ÷ 0.307 s ≈ 16 statements/s per app.
- **Requests that do not touch the DB passed at every step:** ISR pages, search, webhook, mail sync. p95 was 21–63 ms.
- **Requests that touch the DB failed from step 1.** That includes `/api/health`.
- **DB execution time is small** (`pg_stat_statements` on dev, ~20k rows):

  | Query | Mean time |
  |---|---|
  | Actor query | 0.15 ms (19,210 calls) |
  | `site_activity` insert | 0.4 ms |
  | Agent listings list | 12 ms |
  | Listing-activity counts | **96 ms** |
  | Admin `siteTrend` | **115 ms** |

- **Data was never at risk.** `after-run.sql` was all 0: no duplicate texts or charges, no lost webhooks, no dead jobs.
- **Another client holds transactions open on dev.** Backends stayed `active`/`ClientRead` with the transaction open for up to 1,020 s. The query was a listing select through Supavisor.

**Theory (to be proven in Phase 4):** with the app on Vercel `syd1` beside the DB (1–2 ms round trip), V1 fits even
with today's code (est. 500–700 req/s of the V1 mix on ~2 DB cores). The code work below is for:
- spikes and 99.99% success under overload;
- V2/V3 headroom;
- DB cost.

### Rules (from the owner; non-negotiable)
- **Environments.**
  - Dev first. **Never touch production** without the owner's explicit go: no merge to `main`, no migration, no
    setting change.
  - `.env.local` and `.env.dev` are dev.
- **Git.**
  - One task, one branch, one worktree from `origin/main`.
  - Never work in `/Users/saadiii/Job/realestate_ai`: parallel sessions use it.
  - Never `git checkout` over uncommitted work.
  - Never force-push.
- **Secrets and AI.**
  - Never print or commit secrets.
  - No live LLM calls in tests.
  - Smoke runs only small named groups.
- **Dev data.** Synthetic data on dev stays ≤ ~20k rows. The disk is small.
- **Checks.**
  - Every new check is **break-tested**: break the thing it guards and watch it go red.
  - Every changed read path keeps or lowers its statement count, proven in `packages/core/src/listings/query-count.test.ts` or a sibling test.
- **House rules (CLAUDE.md).**
  - `can()` decides permissions.
  - Multi-step writes go in `db.transaction`.
  - Business logic lives in `packages/core`.
  - A big decision gets an ADR first.
- **Reporting.** Report to the owner in Roman Urdu, with the straight count (52/80).

## 1. The order (dependencies)

```
Phase 1 (Claude, dev)   P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8     each its own branch, pushed, not merged
Phase 2 (Claude + go)   production read-only check for stuck ClientRead transactions; alerts
Phase 3 (Owner)         Sydney VM, Vercel previews on dev, firewall bypass, compute/pool settings
Phase 4 (Claude)        valid runs in Sydney: smoke → step V1 → V2 60 min → spike → soak → recovery
Phase 5 (Claude)        fix what the knee names; re-run the step
Phase 6 (Owner go)      one integration branch → production, backup first, watch
```

Phases 1 and 3 run in parallel. Phase 4 needs both.

## 2. Phase 1: code fixes (Claude, on dev)

For every task: **problem → files → change → proof → done when**. Each task ends with the following, and with the
branch pushed and not merged:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` green;
- a break-test;
- a row in the tracker's Log.

### P1. Health check off the shared queue
- **Problem.** `/api/health` waits in the same 5-connection pool as every page. Under load it failed 96–99%, so an
  uptime monitor would report the site down while it is only busy.
- **Files:**
  - `apps/web/app/api/health/route.ts`
  - `apps/console/app/api/health/route.ts`
  - `packages/db/src/client.ts` (`getDb` keys pools by connection string)
- **Change.** Health uses its own pool of 1 connection (e.g. the same URL with `application_name=health`, which
  `getDb` keys separately) and a short timeout. A slow DB answers `503 db_slow` within ~2 s instead of timing out.
- **Proof.** A test where the main pool is held busy and health still answers.
- **Break-test.** Point health back at the shared pool and watch the test go red.
- **Done when** health answers in < 2 s while the main pool is saturated.

### P2. Load shedding: fail fast for low-priority requests (ADR first)
- **Problem.** Nothing limits the wait for a connection. Requests queue until the client's 10 s timeout, so past the
  knee every request fails (80% at every step above 25%).
- **ADR.** Write `docs/adr/NNNN-load-shedding.md` (10 lines). It sets:
  - the priority classes: webhooks > user actions > pages > polls and beacons;
  - the signal: in-flight count per pool, or the wait time;
  - the threshold.
- **Files:**
  - `packages/db/src/client.ts` (count in-flight statements per pool, cheap)
  - `apps/console/app/api/live/route.ts`
  - `apps/console/app/api/notifications/route.ts`
  - `apps/web/app/api/activity/route.ts`
  - `apps/console/components/live-refresh.tsx` (a 503 skips the tick)
- **Change.** When the pool is past the threshold, the low-priority routes return `503` with `Retry-After` at once.
  Pages and actions are untouched.
- **Proof.** A unit test of the threshold function, and a route test showing a 503 when busy.
- **Break-test.** Set the threshold to infinity and watch the test go red.
- **Done when** a saturated pool sheds polls in < 50 ms, and pages still get connections.

### P3. `/api/live`: one light statement
- **Problem.** At V1 this is 100 req/s, 41% of all traffic. Each poll runs 3 serial statements, and the first carries 7
  count sub-queries the route throws away:
  - `loadListingActor` → `loadActorContext` (`apps/console/lib/load-actor.ts`);
  - then `listing_agent`;
  - then `consoleLiveStamp` (`packages/core/src/mail/live.ts`).
- **Change.** One SQL statement that reads the membership (agency, role, status), the listing links (`array_agg`)
  and the stamp. No badges. `can()` still decides the mail scope, so the actor is built from the same row.
- **Later (V2, migration).** A `live_stamp` version row per user, bumped on writes. The poll becomes a primary-key
  lookup.
- **Proof.** A query-count test: `/api/live` = 1 statement, plus 1 a minute for last-seen.
- **Break-test.** Restore `loadListingActor` and watch the count test go red.
- **Done when** it is 1 statement and the stamp is identical to the old one on the seeded fixtures.

### P4. Split the actor (permissions) from the badges (chrome)
- **Problem.** The 7-count actor query runs on every page, every bell (`/api/notifications`) and every poll. Only the
  shell's header needs the counts.
- **Files:**
  - `apps/console/lib/load-actor.ts`
  - `apps/console/lib/require-console-access.ts` (`loadConsoleChrome`, `requireConsoleAccess`)
  - `apps/console/app/api/notifications/route.ts`
- **Change.**
  - `loadActor` reads membership, agency status and sends-paused only.
  - The badges move to `loadConsoleChrome` alone, still one statement.
  - Keep `blocked`, `mfaMark` and `sendsPaused` behaviour exactly as today.
- **Proof.**
  - Permission tests unchanged and green.
  - The query count for the bell drops.
  - The chrome still shows the same counts.
- **Done when** API routes no longer run the badge sub-queries.

### P5. Waterfalls into one round trip
- **Problem.** Independent reads are awaited one after another. Each `await` costs a round trip and holds a pool
  connection longer.
- **Known places:**
  - `apps/console/components/deals/finance-page.tsx`: actor → listing links → `agencyTimeZone` → report;
  - `apps/console/app/(agent)/listings/page.tsx`: list → `matchingBuyerCounts`;
  - `apps/web/app/account/*/page.tsx`: `isUserBlocked` → upsert → threads → guide threads.
- **Change.**
  - `Promise.all` for independent reads.
  - Fold the timezone and the links into existing statements where it is one join or `array_agg`.
- **Proof.** Query-count tests per changed page; the serial depth goes down.
- **Done when** no changed page has two sequential awaits that do not depend on each other.

### P6. No write on a read
- **Problem.** Every buyer account page runs `ensureConsumerAccount` → `ensureAppUser` → `INSERT … ON CONFLICT DO
  UPDATE SET updated_at = now()`. That is a row lock, a new tuple and WAL on every page view.
- **Files:**
  - `apps/web/lib/account.ts`
  - `packages/core/src/identity/ensure-app-user.ts`
- **Change.** `… DO UPDATE … WHERE (email, name, …) IS DISTINCT FROM (excluded…)`: a no-op writes nothing. Or move
  the call to the auth callback only. Choose by reading the callers; the first keeps behaviour.
- **Proof.** A test that a second call with unchanged data updates 0 rows.
- **Break-test.** Drop the `WHERE` and watch the test go red.
- **Done when** a repeat page view writes nothing.

### P7. The slow queries
- **Targets** (dev means; confirm with `EXPLAIN (ANALYZE, BUFFERS)`):
  - listing-activity counts, 96 ms (`packages/core/src/activity/scope.ts` and its callers);
  - admin `siteTrend`, 115 ms (`packages/core/src/platform/site-users.ts:354`);
  - agent listings list, 12 ms;
  - suburb aggregate, 13 ms.
- **Change.** Indexes through `packages/db/src/concurrent-indexes.ts`, built concurrently. A migration for an index
  needs the owner's go for production. Use counters only if an index cannot do it.
- **Proof.** Before and after `EXPLAIN` in the branch's commit message. `pnpm db:slow-queries` shows the drop.
- **Done when** each is < 20 ms on dev, or the reason it cannot be is written down.

### P8. `statement_timeout` per kind of work (tracker 1.8 part 2)
- **Problem.** A runaway or stuck statement holds a connection indefinitely.
- **Change.** Per pool or role:
  - requests: e.g. 5 s;
  - cron and jobs: longer;
  - set on the connection.

  Read ADR 0094 first: the pool runs with `max_pipeline: 0` and a postgres.js patch. Test pools of size 1, 2 and 5,
  direct and through the pooler, with a transaction mixed in. The ADR 0094 patch once deadlocked the production cron.
- **Proof.** A test where `pg_sleep` past the limit is cancelled.
- **Done when** no request statement can run longer than its limit.

**Deferred to V2** (write down, do not build now):
- `live_stamp` version table;
- beacon batching;
- badge counter tables;
- read replica for admin and insights;
- Realtime push instead of polling (V3);
- `site_activity` partitions (V3).

## 3. Phase 2: watch for stuck transactions (Claude; production needs the go)
1. Add to `/api/health/alerts` (or the stability watch) a count of backends `state = 'active' AND wait_event =
   'ClientRead' AND now() - xact_start > interval '60 seconds'`. Today's watch only looks at `idle in transaction`
   and misses this.
2. **With the owner's go:** one read-only `pg_stat_activity` query on production for that pattern. Report it, change
   nothing.
3. On dev, find the other client: `client_addr` and `application_name`. Ask the owner whether the other developer or
   a dev preview was running.

## 4. Phase 3: the Sydney setup (owner, with Claude's help)
| Step | Who | What |
|---|---|---|
| 3.1 | Owner | AWS account on the **Free plan** → region `ap-southeast-2` → EC2 Ubuntu 24.04, `m7i-flex.large`, 20 GB, SSH from the owner's IP only |
| 3.2 | Claude | On the VM: `load/vm-setup.sh`; copy `.env.dev` with `scp`, never git |
| 3.3 | Owner | Vercel previews of all four projects pointed at dev, every vendor stubbed (README "The day", step 3) |
| 3.4 | Owner | Vercel Firewall **System Bypass** rule for the VM's IP; bypass secret to Claude as `VERCEL_BYPASS`; Attack Mode off |
| 3.5 | Owner | Dev compute and pooler pool size as production (1.9, 1.19). Optional: a pass on smaller compute still counts |
| 3.6 | Both | Nobody else on the dev DB during the runs (the `ClientRead` backends spoil them) |

## 5. Phase 4: the runs (Claude, from the Sydney VM)
Every run goes through `load/run.sh`. The report's **validity block must be all green** before any number counts.

| # | Run | Command (plus the preview URLs and `STRIPE_WEBHOOK_SECRET=whsec_load_test`) | Pass |
|---|---|---|---|
| 4.1 | Smoke | `-e MODE=smoke` | Script works, 0 errors |
| 4.2 | Step V1 | `-e MODE=step -e PROFILE=v1` (~90k requests, ~17 min) | Every step ≤ 1% errors, section 5 p95s, no knee |
| 4.3 | Step V2 | `-e MODE=step -e PROFILE=v2` | Find the knee; V1 must sit at ≤ 50% of it |
| 4.4 | Load V2 | `-e MODE=load -e PROFILE=v2` (60 min) | Section 5 holds; **99.99% success** |
| 4.5 | Spike | `-e MODE=spike -e PROFILE=v2` (10× for 5 min) | Pages and webhooks ≥ 99.9%; polls may shed (P2); recovers within 2 min |
| 4.6 | Soak | `-e MODE=soak -e PROFILE=v1` (2 h) | No memory growth, no drift in p95 |
| 4.7 | Recovery | README "The day", step 6: pooler cut, vendor down, tick killed mid-batch | Errors return to normal within 2 min; `after-run.sql` 0 |

Before each run:
- `node load/sessions.mjs` (sessions live about an hour);
- seed only within the dev disk rule. V2 data needs the owner to raise dev's disk first.

After all runs:
- `node load/sessions.mjs --delete`;
- `psql "$DIRECT_URL" -f load/cleanup.sql`;
- lower the compute;
- stop the VM;
- rotate the bypass secret.

## 6. Phase 5: when a step fails, read the knee
| The report shows | Cause | Next |
|---|---|---|
| DB CPU high, slow queries on top | Heavy statements | P7 on the named query, or the compute size |
| `max client connections` / pooler errors | Instances × `DB_POOL_MAX` over the pooler's clients | Lower `DB_POOL_MAX` or raise the compute |
| Pool wait high, DB CPU low | Too many statements per request | P3–P5 on the busiest kind |
| Function 5xx, server CPU high | Rendering cost | Profile the page; cache what can be cached |
| 403/429 from Vercel | Firewall | Bypass rule, then re-run (not a platform result) |
| `ClientRead` backends grow | A stalled client or pooler | Phase 2; ADR 0094 settings |

Fix one cause, re-run the same step, and compare in the report's "Against the run before" block.

## 7. Phase 6: production (only with the owner's go)
1. All Phase 1 branches merged into one `integrate/v1-performance` branch. Clean-worktree typecheck, lint, tests and
   builds pass.
2. If a migration or index is involved:
   - a production backup, verified;
   - then apply from a checkout whose journal ends at that migration (the house procedure in the tracker's Log).
3. Merge with `--no-ff`. Vercel success on all four projects. `/api/health` ok on all four.
4. Watch for 10 minutes:
   - 5xx rate;
   - p95;
   - pool waits;
   - `idle in transaction` **and** `active/ClientRead`.
5. Tracker:
   - 4.3 → Done, with the p95s, error rate and after-run counts;
   - the Log row;
   - the count reported straight.

## 8. What is not in this plan (owner actions that block launch, tracked elsewhere)
| Area | Tasks |
|---|---|
| Rate limit and bot protection | Shared rate limiter 1.4 (Upstash, O-15); firewall and Turnstile 1.5 (O-16) |
| Backups and recovery | 0.4, 0.8 (O-6–O-9); PITR 0.3 (Decision 7); restore drill 4.4 (O-19); rollback drill 4.8 |
| Monitoring | Sentry 0.7 (O-13); uptime monitor 1.14 |
| Email, domains, sender ID | SMTP 0.10; DNS and email 5.5, 5.6 (O-22); ACMA 5.7 |
| Legal | 5.1, 5.2, 5.11 (lawyer, O-21) |
| Accounts | Business accounts 5.9; status page 5.10 |

Full list: `V1-OWNER-ACTIONS.md`.

## 9. Expected numbers (theory; Phase 4 replaces them)
| | Capacity (V1 mix) | `/api/live` p95 | Console page p95 |
|---|---|---|---|
| Laptop run (measured) | ~3 req/s | 10 s (timeout) | 10 s (timeout) |
| Sydney, today's code | ~500–700 req/s | ~20–40 ms | ~200–400 ms |
| Sydney + P1–P6 | ~700–900 req/s | ~10–20 ms | ~150–300 ms |
| + P7 | ~1,200–1,500 req/s | same | lower on the heavy pages |

Assumptions:
- ~2 DB cores at 70%;
- 15 pooler backends;
- 1–2 ms round trip;
- dev-sized data.

Data at V2 size (2.5M contacts) can make the count queries 10–50× slower. That is the largest unknown, and run 4.3
answers it.
