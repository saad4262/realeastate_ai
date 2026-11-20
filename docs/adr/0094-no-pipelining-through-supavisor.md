# 0094: No statement pipelining through Supavisor

**Status:** accepted 2026-11-20 (found while working on PLATFORM-PLAN 1.10–1.13).

**Problem.** The admin home (`/platform`) never finished loading. When a connection is busy, postgres.js sends the
next statement on it straight away (pipelining, up to 100 per connection). This applies only to statements without
parameters, because those with parameters are described first. In transaction mode, Supavisor loses the reply to a
pipelined statement once the earlier one ends its transaction, and the awaiting code waits forever. The admin home
runs about 13 statements against a pool of 5. Inside `db.transaction` pipelining is safe: the backend stays pinned
until commit.

Measured on dev, 13 statements over 5 pooled connections:
- pipelined: 3 of 3 runs hung;
- `max_pipeline: 1`: still hung;
- `max_pipeline: 0`: 6 of 6 runs finished, with 13 and with 40 statements.

The same failure is reported upstream in porsager/postgres #970, still open.

**Decision.** `poolOptions()` sets `max_pipeline: 0`: one statement in flight per connection, and the rest wait in
the queue. postgres.js 3.4.9 only reserves a transaction's connection (`onexecute`) when the pipeline limit allows
it, so with 0, `sql.begin` fails with UNSAFE_TRANSACTION. A one-line `pnpm patch` (`patches/postgres@3.4.9.patch`)
always reserves it. The guard is the smoke check "Database pool through the pooler": 3 × `max` statements plus a
transaction must all answer. It turned red with pipelining back on.

**Upgrading postgres.js.** pnpm refuses a patch that no longer applies. Check whether upstream fixed `onexecute`,
re-make the patch or drop it, and run the smoke check.

## Second attempt, 2026-11-20

**The first rollout was reverted.** Within minutes of deploying it, the minute tick on production left sessions
idle in a transaction, holding locks across the tick's tables (one for over 6 minutes). It was reverted (db76874).
A dev probe at the time seemed to show the patched driver deadlocking on a pool of 2. That probe was wrong: its 20 s
limit was shorter than dev's slow round trips, and the patched run simply took longer.

**Measured again on dev** with a 90 s limit: 40 operations (a quarter of them transactions with two statements,
the rest plain statements, with and without parameters), at pool sizes 1, 2 and 5, direct and through the pooler.

| Driver | Through the pooler | Direct |
|---|---|---|
| Unpatched (pipelining) | **Hangs** at 1, 2 and 5 | Finishes at 1, 2 and 5 |
| Patched, `max_pipeline: 0` | Finishes at 1, 2 and 5 | Finishes at 1, 2 and 5 |

- Through the pooler, patched, pool 2 finished in 2 of 3 runs. The third ended with a Node error, not a hang, and
  did not recur.
- Earlier 8 s and 20 s limits made both drivers look hung. That was dev's latency.

Real minute ticks, run on dev through the pooler with the patched driver, never left a session idle in a
transaction for more than 3 s: 2 and 4 overlapping, at pools 2 and 5. **The production incident has not been
reproduced on dev.** Its cause is unknown. It may involve Vercel freezing a function between invocations, or
production's own data.

**So the fix ships with a guard against the unknown: an idle-in-transaction timeout (migration 0106).** The app's
role ends a session idle inside a transaction after 30 s:
`ALTER ROLE postgres SET idle_in_transaction_session_timeout = '30s'`.
- Our code never waits on the network inside a transaction, so nothing legitimate idles that long.
- A stuck connection now costs one failed round instead of minutes of held locks.
- On dev, six transactions left idle for 35 s were ended at 30 s.
- Overlapping real ticks ran clean with the timeout in force.
- Smoke check: "the app role ends a session left idle inside a transaction".

**Rollout.** Deploy, then watch production for 10 minutes for sessions idle in a transaction. If one lasts over
20 s, revert at once (the owner's go covers that revert).

**postgres.js 4** (4.1.1, 2026-11-11) was considered and set aside:
- It rewrites the pool, but still pipelines onto busy connections.
- It changes how parameter types are inferred, which would need its own review of every query.
- Supavisor's own fix (supabase/supavisor#1207) is unreleased.
- Revisit when either ships and has been out a few weeks.
