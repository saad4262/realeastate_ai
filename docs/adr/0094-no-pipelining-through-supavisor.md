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
