-- ADR 0094: a session of the app's role idle inside a transaction for 30 s is ended by Postgres, so a stuck
-- connection (2026-11-20: the minute tick's sessions held locks for minutes) never holds locks for long. Our code
-- never waits on the network inside a transaction (CLAUDE.md), so nothing legitimate idles that long. Role-level,
-- not database-level: Supabase's own services keep their settings. Applies to sessions started after it.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
ALTER ROLE postgres SET idle_in_transaction_session_timeout = '30s';
