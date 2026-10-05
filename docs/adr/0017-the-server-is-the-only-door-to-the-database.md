# 0017 — The server is the only door to the database

**Status:** proposed, 2026-10-05. Migration 0019. Applies to dev, then prod.

**Context.** Every query this platform makes goes through the server, as the `postgres`
owner, which bypasses RLS and decides with `can()`. supabase-js is used for auth and
Storage only; no code reads a table through Supabase's Data API. Yet `anon` and
`authenticated` held ALL privileges on every public table (Supabase's default), four
tables (`ai_run`, `event`, `shortlist`, `team_member`) had no RLS, and several policies
were wider than `can()`: any member could UPDATE any listing in their agency (publishing
past ADR 0014's approval), read every lead including private offers, and every email;
`agent_profile` was readable by anyone, commission split included. The anon key ships to
the browser, so with the Data API on, these were reachable from the internet.

**Decision.** Revoke every table, sequence and own-function privilege from `anon` and
`authenticated`, and the default privileges that would grant them on future tables. Turn
RLS on everywhere as the second lock. Drop the policies wider than `can()`; keep the
narrow self-only ones; `agent_profile` reads only rows marked `public`. Smoke check
"the public schema is closed to the browser keys" holds the line.

**Alternatives.** Rewriting each policy to mirror `can()` — two copies of the rules,
which drift. Switching off the Data API in the dashboard only — not in a migration, so
a new project (prod in Sydney) would start open again. It may still be switched off too.

**Consequences.** A browser `supabase.from(...)` gets "permission denied". Giving the
browser direct table access in future is a new ADR, with policies that match `can()`.
Reversible with GRANT.
