# Running the scheduler

`POST|GET /api/cron/alerts` runs every saved search that is due. It accepts
nothing but a shared secret — no body, no query parameters, no ids — and
works out what is due itself (ARCHITECTURE § 9).

## By hand

```bash
curl -s -X POST http://web.lvh.me:3000/api/cron/alerts \
  -H "x-cron-secret: $CRON_SECRET" | jq
```

Answers `{ ok, claimed, delivered, empty, failed, emailsSent, emailsSkipped,
budget, durationMs }`. It never 5xxs because an individual schedule failed —
the platform would retry the whole tick straight back into whatever broke,
with a metered model and a mail provider behind it. Only an unauthorised
call (401), an unconfigured secret (503) or a scheduler that could not start
at all (503) is an error status.

## On Vercel

`vercel.json` declares a 5-minute cron. Two things to know:

- **Vercel Hobby only runs crons once a day.** The 5-minute schedule needs
  Pro. Nothing about the endpoint depends on Vercel, though — it authorises
  a shared secret and ignores who is calling, so GitHub Actions `schedule`,
  cron-job.org or any other pinger works identically.
- Vercel Cron issues a **GET** with `Authorization: Bearer $CRON_SECRET` and
  cannot be told to send a custom header. The guard accepts that form as
  well as `x-cron-secret`; both are headers, because a secret in a query
  string lands in access logs and in a Referer.

## Why 5 minutes

Two separate reasons, and both have to hold.

**Precision.** Schedules fire on a local wall clock, so the tick has to be
finer than the precision people expect. Every 5 minutes means an alert set
for 8:00 PM arrives by 8:05 at the latest.

**Catch-up.** `nextRunFor` advances an interval schedule exactly one slot
from the slot it just ran, never to `now` — that is what keeps an 8 PM
alert at 8 PM after an outage. The cost is that a row catches up at one
slot per tick, so the tick has to be strictly faster than the shortest
interval or a schedule that falls behind never returns. The floor is 10
minutes (`MIN_INTERVAL_MINUTES`) against a 5-minute tick: 2:1, and a
backlog drains at twice the rate it built. **These two numbers are a pair.
Changing either without the other is the bug.**

A tick claims at most 10 schedules and leaves the rest for the next one —
`next_run_at <= now()` does not expire, so a backlog drains rather than
being dropped.

## What one run costs

The search is SQL and costs nothing. The summary is one Haiku call of at most
400 output tokens, and it is skipped entirely when `checkAiBudget` says the
trailing-24h spend is over `AI_DAILY_BUDGET_USD` or the per-user cap — the
alert still goes out, with a templated sentence instead of prose.

A run that finds nothing new costs nothing at all and sends nothing: the
empty branch returns before the model call and before the transport. This
is what makes a 10-minute schedule affordable — 144 runs a day, of which
the overwhelming majority are one SQL query and a row.

`ALERTS_DRY_RUN=1` runs the whole pipeline and sends no mail. Use it on any
preview deployment that shares the production database.
