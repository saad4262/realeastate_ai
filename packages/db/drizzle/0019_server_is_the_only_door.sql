-- The server is the only door to the database. See docs/adr/0017.
--
-- Hand-written. Every query this platform makes goes through the server as the
-- `postgres` owner, which bypasses RLS and decides with can(). Nothing reads a
-- table through Supabase's Data API (PostgREST / GraphQL) — supabase-js is used
-- for auth and Storage only. Yet `anon` and `authenticated` held ALL privileges
-- on every public table, so the public anon key could read and write anything
-- RLS did not stop: four tables had no RLS at all, and several policies were
-- wider than can() (any member updating any listing, reading every offer).
-- Taking the grants away closes that without a second copy of can() in SQL.
--
-- Not touched: the `storage` schema (bucket policies), `auth`, and the server's
-- own role. Reversible with GRANT if a browser ever needs direct table access —
-- which would be a decision for a new ADR, not a quiet fix.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.user_agency_ids() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mail_thread_for_lead() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mail_thread_subject(lead_kind, uuid) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- Tables, sequences and functions created by later migrations (owned by
-- postgres) no longer get those grants by default either.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- The second lock: RLS on every table. No policy means nobody but the owner.
ALTER TABLE "ai_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shortlist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Policies wider than can(), removed so that a grant restored by accident does
-- not reopen them. The narrow self-only and member-scoped read policies stay.
DROP POLICY IF EXISTS listing_update_member ON listing;--> statement-breakpoint
DROP POLICY IF EXISTS lead_select_member ON lead;--> statement-breakpoint
DROP POLICY IF EXISTS mail_thread_select_member ON mail_thread;--> statement-breakpoint
DROP POLICY IF EXISTS mail_message_select_member ON mail_message;--> statement-breakpoint
DROP POLICY IF EXISTS agent_profile_select ON agent_profile;--> statement-breakpoint
CREATE POLICY agent_profile_select_public ON agent_profile FOR SELECT USING (public = true);
