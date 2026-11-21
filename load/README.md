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

## A population run (5–10 minutes, any size)
`PROFILE=pop` turns people online into requests a minute per kind (`catalog.js`, above `PER_MIN`): public pages and the
activity beacon, a buyer's account pages and presence ping, an agent's pages, poll, bell and inbox pull, an owner's
agency pages, poll and bell, the platform admin's pages, the Stripe webhook and both health checks. No AI route
(tokens) and no Google route (`/api/places`). `MODE=run` ramps up for `RAMP` (2m), holds for `HOLD` (5m), ramps down
for 1 minute.

```
set -a; source .env.dev; set +a
psql "$DIRECT_URL" -f load/cleanup.sql
psql "$DIRECT_URL" -v agencies=200 -v agents=5 -v contacts=100 -v listings=20 -v buyers=50 -f load/seed.sql
node load/targets.mjs
load/local-servers.sh build && load/local-servers.sh start   # or point WEB/AGENTS_URL/… at a preview
node load/sessions.mjs            # right before the run: the cookies live as long as an access token
WEB_LOG=load/runs/servers/web.log CONSOLE_LOG=load/runs/servers/console.log \
  load/run.sh -e MODE=run -e PROFILE=pop -e AGENCIES=200 -e AGENTS=1000 -e USERS=10000 -e STRIPE_WEBHOOK_SECRET=whsec_load_test
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
