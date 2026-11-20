# 0097: Peak shaping — what keeps 9 am from taking the platform down

**Status:** accepted 2026-11-20 (PLATFORM-PLAN 3.6). Builds on 3.3 (fair SMS drain) and 3.5 (email retry).

- **People and webhooks never share a pool with bulk work.**
  - Cron ticks run in their own Vercel invocation, with their own pool (`DB_POOL_MAX`, default 5).
  - Pages and webhooks run in theirs.
  - So a busy tick can hold at most its own few connections; it cannot take the ones a person's page needs.
  - Inside a tick, work runs one job at a time, and each round must fit in the time left (`runTick`).
- **Lanes.** The job queue has `urgent`, `send` and `bulk` lanes, each claimed in its own fair-by-agency batches
  (3.1). Webhooks answer first and do their work after (3.2).
- **9 am.**
  - SMS batches held overnight go out a slice per agency per round, the least recently served agency first (3.3).
  - A recurring send held for the sending hours comes back at the opening, moved by a fixed 0–5 minute offset
    for its agency (`spreadOpening`), so held sends do not all land on one tick.
  - A time a person chose is never moved.
- **One limiter per vendor.**
  - Anthropic: the SDK retries a 429 with its own Retry-After handling.
  - Resend: the transport retries under one Idempotency-Key and honours Retry-After up to 5 s. After one email
    has used up its retries, sends fail fast for 30 s. A send is one request, about 10 a second at most from a
    tick.
  - Twilio: it queues per sending number on its side. We keep to the per-number daily limit (rule 5).
- **Not proven here:** that a person's page and a webhook stay within budget while 200 agencies' 9 am sends drain.
  That is the spike test on the load-test day (PLATFORM-PLAN 4.3), against a raised dev. A 200-agency load on
  today's dev disk would repeat the 2026-11-20 WAL incident.
