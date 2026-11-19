# Load test (PLATFORM-PLAN 4.3)

Run by hand on a planned day, never in CI, **never against production** (the script refuses the production domain
and `targets.mjs` refuses the production database). Pass: section 5 holds **at V2 numbers** (V1 must carry V2).

| File | What |
|---|---|
| `seed.sql` | Seeds the dev database (rows marked `load-`): agencies, members, contacts, listings |
| `targets.mjs` | Writes `targets.json` (listing ids, suburbs, console paths) from the target database; read-only |
| `platform.js` | k6: public listing, search, console pages, `/api/live`, a signed webhook; `MODE` × `PROFILE` |
| `after-run.sql` | What a run must not leave: duplicate texts or grants, stuck texts, lost events, dead or abandoned jobs |
| `cleanup.sql` | Removes everything `seed.sql` made |

## The day
1. **Owner:** raise the dev database to production's compute for the day (Supabase → dev → Compute; a few minutes
   of restart). Lower it again at the end: it costs by the hour.
2. **Seed at V2:** `psql "$DIRECT_URL" -v agencies=500 -v agents=2 -v contacts=5000 -v listings=30 -f load/seed.sql`
   (1,000 agents, 2.5M contacts, 15,000 listings), then `node load/targets.mjs`.
3. **A preview pointed at dev, every vendor faked:** `PHONE_STUB=1`, `INTEGRATIONS_STUB=1`, `EMAIL_DEV_ALLOWLIST` to one
   test address, `SMS_DEV_ALLOWLIST` to one test number, no `STRIPE_SECRET_KEY`, a test `STRIPE_WEBHOOK_SECRET`, and
   `AI_DAILY_BUDGET_USD=0` (no model call is made; the assistant's first-token target is measured separately with
   a fake model, not here).
4. **A console session:** sign in on the preview as a seeded owner (set a password for `load-1-1@load.test` in
   Supabase Auth) and copy the session cookie into `CONSOLE_COOKIE`.
5. Runs (each ends with `after-run.sql`: every count 0):
   - `k6 run -e MODE=smoke …` (30 s: the script works)
   - `k6 run -e MODE=load -e PROFILE=v2 …` (60 min)
   - `k6 run -e MODE=spike -e PROFILE=v2 …` (the 9 am spike: 10× for 5 min)
   - `k6 run -e MODE=soak -e PROFILE=v1 …` (2 h)
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
