# Load test (PLATFORM-PLAN 4.3)

Run by hand on a planned day, never in CI, **never against production** (the script refuses the production domain
and `targets.mjs` refuses the production database). Pass: section 5 holds **at V2 numbers** (V1 must carry V2).

| File | What |
|---|---|
| `seed.sql` | Seeds the dev database (rows marked `load-`): agencies, members (owner + agents), contacts and listings shared out to agents, buyers, one platform admin |
| `targets.mjs` | Writes `targets.json` (listing, property and agency ids, suburbs) from the target database; read-only |
| `platform.js` | k6: one scenario per request in `catalog.js`; `MODE` × `PROFILE` |
| `after-run.sql` | What a run must not leave: duplicate texts or grants, stuck texts, lost events, dead or abandoned jobs |
| `cleanup.sql` | Removes everything `seed.sql` made |
| `catalog.js` | **Every request**: who makes it (visitor, buyer, agent, owner, admin, system), what it stands for, the code that answers it, how often, its budget |
| `sessions.mjs` | Signs in seeded agents, owners, buyers and the admin → `sessions.json`; `--delete` removes their Auth users |
| `profile.mjs` | Before the load: each request ALONE — its time and how many database statements it runs, and the database round trip |
| `run.sh` | One run, everything kept in `runs/<time>/`: profile, every request (`k6.csv.gz`), DB and CPU samples, server logs, reports |
| `sampler.mjs` | Every 5 s during a run: DB connections by state, transactions/s, cache hit, longest query, the servers' and k6's CPU and memory |
| `local-servers.sh` | `build` / `start` / `stop`: both apps on this machine, production builds, the dev database, every vendor key replaced |
| `report.mjs` | `report.html` (per kind of user, the bottlenecks found with their evidence, charts, logs), `results.md` (the same as text, for Claude or a ticket), `results.json` |

**Always first, in every terminal:** `set -a; source .env.dev; set +a`. Every script refuses the production database,
but `.env.local` on a laptop may still point at it (O-5c).

## How a run is judged (2026-11-21, after the first full run)
The report answers two questions, in this order:
1. **Was it a valid test?** Servers within 5 ms of the database, k6 sent everything it was asked (`dropped_iterations`
   0), k6's machine under 80% CPU and apart from the servers, no load-generator errors, sessions held, and the
   database quiet before the run (under 2 statements/s of other traffic: two runs on one dev database spoil both,
   and statements stuck `active`/`ClientRead` with the transaction open are another client's). If not, the
   report says so at the top and grades nothing: the numbers describe the setup (the 2026-11-21 laptop run: 366 ms
   round trip, 57,933 requests never sent, k6 on the same machine as both apps).
2. **Did it meet section 5?** p95 against each target (listing TTFB 200 ms, search 500 ms, console pages 800 ms,
   `/api/live` 100 ms, webhook 1 s), errors under 1%, `after-run.sql` all 0. Each request also has its own budget for
   the first byte and 3 s for the whole response (a streamed page can send its shell early and the rest never).

Lessons built in (k6 "Running large tests", Vercel's load-testing guide, Supabase pooling limits): an open model
(arrival rate, so a slow server does not quietly get less load); step up to find the knee instead of starting past
it (`MODE=step`); a 10 s timeout (past that a person has left; 30 s only measured the queue); the profile takes other
traffic off each statement count; the sampler records what the longest statement waits on (`ClientWrite` = a client
that stopped reading). `node load/catalog.test.mjs` checks the rates, steps and both judgements.

## A population run (5–10 minutes, any size)
Every `PROFILE` is people online, turned into requests a minute per kind (`catalog.js`, above `PER_MIN`): public
pages and the activity beacon, a buyer's account pages and presence ping, an agent's pages, poll, bell and inbox
pull, an owner's agency pages, poll and bell, the platform admin's pages, the Stripe webhook (1.5 a minute per agency)
and both health checks. `v1`/`v2`/`v3` are section 3's numbers (200/500/2,000 · 500/1,000/5,000 · 1,000/2,000/10,000
agencies/agents/users); `pop` takes `AGENCIES`/`AGENTS`/`USERS`. No AI route (tokens) and no Google route
(`/api/places`). `MODE=run` ramps up for `RAMP` (2m), holds for `HOLD` (5m), ramps down for 1 minute. `MODE=step`
holds `STEPS` fractions of the full rate (`0.05,0.1,0.25,0.5,1`) for `STEP` (3m) each: the report grades every step
and names the first one that failed (the knee).

**On a laptop far from the database**, keep the population small enough to stay under the pool's ceiling
(10 connections ÷ the round trip, e.g. 10 ÷ 0.31 s ≈ 32 statements a second) and read per-request times, not failure
rates: `-e PROFILE=pop -e AGENCIES=2 -e AGENTS=6 -e USERS=40`.

```
set -a; source .env.dev; set +a
psql "$DIRECT_URL" -f load/cleanup.sql
psql "$DIRECT_URL" -v agencies=200 -v agents=5 -v contacts=100 -v listings=20 -v buyers=50 -f load/seed.sql
node load/targets.mjs
load/local-servers.sh build && load/local-servers.sh start   # or point WEB/AGENTS_URL/… at a preview
node load/sessions.mjs            # right before the run: the cookies live as long as an access token
WEB_LOG=load/runs/servers/web.log CONSOLE_LOG=load/runs/servers/console.log \
  load/run.sh -e MODE=step -e PROFILE=v1 -e STRIPE_WEBHOOK_SECRET=whsec_load_test
open load/runs/<time>/report.html  # results.md beside it is the text to give to Claude
```
Servers: `WEB`, `AGENTS_URL`, `AGENCY_URL`, `ADMIN_URL` (local `*.lvh.me` by default). `ONLY=agent,owner` runs only those
users. `SKIP_PROFILE=1` skips the one-by-one profile (it takes a few minutes far from the database).
At the end: `node load/sessions.mjs --delete`, then `psql "$DIRECT_URL" -f load/cleanup.sql`.

**Read the profile first.** If the database round trip from the servers is more than a few milliseconds, every
number in the run is the network's: servers on a laptop in Pakistan wait ~600 ms per statement on the Sydney
database (2026-11-20), against ~1–2 ms from Vercel syd1. Run the servers next to the database for real numbers.
Dev at ~20k rows is the house rule since the 2026-11-20 disk incident: more data needs the owner to raise dev's disk
and compute first.

## A free machine in Sydney (k6 beside the servers and the database)
Users, Vercel (`syd1`) and the database are all in Sydney, so k6 must be too: from Pakistan every request carries
~300 ms of distance and the TTFB targets fail on geography alone.
1. **Owner:** a new AWS account on the **Free plan** (credits; the account is not charged, it stops when they run
   out). Region **Asia Pacific (Sydney) ap-southeast-2** → EC2 → Ubuntu 24.04, `m7i-flex.large` (2 vCPU, 8 GB; free
   plan eligible), 20 GB disk, SSH from your IP only. **Stop the instance after the test.**
2. On it: `curl -fsSL https://raw.githubusercontent.com/saad4262/realeastate_ai/test/4.3-load-judged/load/vm-setup.sh | bash`,
   then `scp .env.dev ubuntu@<ip>:realestate_ai/` and log in again.
3. Vercel previews of all four projects on dev (step 3 below), a firewall **System Bypass** rule for the VM's IP and
   the bypass secret as `VERCEL_BYPASS` (rotate it afterwards).
4. Seed, `targets.mjs`, `sessions.mjs` from the VM (it is 1–2 ms from the database, so the seed is fast too), then
   `load/run.sh -e MODE=step -e PROFILE=v1 -e WEB=… -e AGENTS_URL=… -e AGENCY_URL=… -e ADMIN_URL=… -e STRIPE_WEBHOOK_SECRET=whsec_load_test`.
   The report's validity block must be all green; k6 over 80% CPU (2 cores) means V2 needs a second machine.
5. `scp -r ubuntu@<ip>:realestate_ai/load/runs/<time> load/runs/` to read the report here.

Not free: Vercel function time during the run (watch Usage) and raising dev's compute (optional: a pass on dev's
smaller compute is a pass; a failure there may be the compute).

## The day
1. **Owner:** raise the dev database to production's compute for the day (Supabase → dev → Compute; a few minutes
   of restart). Lower it again at the end: it costs by the hour.
2. **Seed at V2:** `psql "$DIRECT_URL" -v agencies=500 -v agents=2 -v contacts=5000 -v listings=30 -f load/seed.sql`
   (1,000 agents, 2.5M contacts, 15,000 listings), then `node load/targets.mjs`.
3. **A preview pointed at dev, every vendor faked:** `PHONE_STUB=1`, `INTEGRATIONS_STUB=1`, `EMAIL_DEV_ALLOWLIST` to one
   test address, `SMS_DEV_ALLOWLIST` to one test number, no `STRIPE_SECRET_KEY`, a test `STRIPE_WEBHOOK_SECRET`, and
   `AI_DAILY_BUDGET_USD=0` (no model call is made; the assistant's first-token target is measured separately with
   a fake model, not here).
4. **Sessions:** `node load/sessions.mjs` (agents, owners, buyers and the admin, signed in against the dev project),
   right before each run.
5. Runs, each through `load/run.sh` with the preview's URLs (`-e WEB=… -e AGENTS_URL=… -e AGENCY_URL=… -e ADMIN_URL=…`);
   each ends with `after-run.sql` (every count 0) and a report:
   - `-e MODE=smoke` (30 s: the script works)
   - `-e MODE=load -e PROFILE=v2` (60 min)
   - `-e MODE=spike -e PROFILE=v2` (the 9 am spike: 10× for 5 min)
   - `-e MODE=soak -e PROFILE=v1` (2 h)
6. **Recovery run** (during a `MODE=load` run):
   - Cut the database's connections for a minute (Supabase → Database → restart the pooler, or terminate the app's
     backends with `pg_terminate_backend`): errors may rise during the cut, and must return to normal within two
     minutes without a redeploy.
   - A vendor down: point `PHONE_WEBHOOK_BASE`/Twilio's stub at a black hole; texts stay `queued` and the stuck-SMS
     check settles them afterwards, never sending twice.
   - Kill a tick in the middle of an SMS batch: start a bulk SMS batch of a few hundred seeded contacts, and while
     `/api/cron/minute` is running, redeploy the preview (the tick dies mid-batch). After the next ticks:
     `after-run.sql` shows no recipient with two texts and nothing stuck.
7. Write the p95s, error rate and after-run counts into `V1-IMPLEMENTATION-STATUS.md` row 4.3, with the date.
8. `psql "$DIRECT_URL" -f load/cleanup.sql`, lower the compute.

## Rates (requests a second at peak, `platform.js`)
| | listing | search | console page | `/api/live` | webhook |
|---|---|---|---|---|---|
| v1 | 15 | 5 | 17 | 100 | 5 |
| v2 | 35 | 12 | 33 | 200 | 10 |
| v3 | 70 | 25 | 67 | 400 | 20 |

From section 3: listing views a month (peak ≈ 3× the average over a 12-hour day), console tabs at peak (one page
every 30 s), the 5-second poll at the top of its range.

## Checked so far (2026-11-19)
Seed at 20 agencies, `targets.mjs`, a 30-second `MODE=smoke` against a local `next dev` web server on the dev
database (75 requests, 0 errors, the signed webhook answered 200 and stored nothing; listing and search over their
p95: expected for a dev server with no ISR, and it shows the thresholds fail), `after-run.sql` (all 0), `cleanup.sql`
(0 rows left). The console scenarios need a preview and a cookie: not yet run.
