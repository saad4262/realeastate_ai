# 0095: Data layout while the tables are small: UUIDv7, lz4, trigram search

**Status:** accepted 2026-11-20 (PLATFORM-PLAN 1.12, migration 0104).

- **UUIDv7 ids on the 29 tables that grow.** Examples: site_activity, lead, contact, messages, jobs, ai_run, audit_log.
  A random v4 id lands on a random page of the primary key, so the whole index stays hot and splits everywhere. A
  time-ordered id lands at the right edge. Postgres 17 has no `uuidv7()` and Supabase has no `pg_uuidv7`, so
  `public.uuid_v7()` is a one-line SQL function implementing RFC 9562: 48 bits of milliseconds, then randomness.
  - Existing rows keep their v4 ids, and nothing reads the version.
  - Zod and the repo's own id checks accept any version.
  - 74 random bits remain, so ids stay unguessable.
  - An id now shows when its row was made. No id in this app is a secret.
- **lz4 for every new value large enough to compress.** This is set per database (`default_toast_compression`), not
  per column. lz4 is several times faster than pglz to compress and read, at about the same size. Old values stay pglz
  until rewritten, and Postgres reads both.
- **Trigram search for the contacts directory.** The five `ilike '%term%'` tests (name, email, phone, suburb, street)
  became one test on `contactSearchText()`, a single expression defined in `schema.ts`. The query and its GIN trigram
  index both use it.
  - Results are identical (checked on 20k contacts), except that a term can now match across two fields, a harmless
    superset.
  - The admin console's searches and the address searches stay unindexed. Those tables are small, or the search
    already narrows by agency first.
