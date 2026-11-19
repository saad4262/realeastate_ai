-- PLATFORM-PLAN 1.11-1.13: data layout while the tables are small. Additive; every statement is idempotent.
-- 1.13: no statement waits more than 1 s for a lock (a migration that cannot get one fails and is re-run).
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
-- 1.11: the index advisor (pg_stat_statements is on already).
CREATE EXTENSION IF NOT EXISTS hypopg WITH SCHEMA extensions;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS index_advisor WITH SCHEMA extensions;--> statement-breakpoint
-- 1.12: trigram search (the contacts directory), lz4 for values large enough to compress, UUIDv7 ids on tables that grow
-- (time-ordered, so new rows land at the right edge of the primary key instead of a random page). Postgres 17 has no
-- uuidv7(); this is RFC 9562: 48-bit Unix milliseconds, version 7, the rest random.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.uuid_v7() RETURNS uuid LANGUAGE sql VOLATILE PARALLEL SAFE SET search_path = '' AS $$
  select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid
$$;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET default_toast_compression = lz4', current_database()); END $$;--> statement-breakpoint
ALTER TABLE "activity" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "ai_run" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "assistant_turn" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "automation_event" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "automation_run" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "chat_message" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "contact" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "deal_event" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "document_chunk" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "email_batch_recipient" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "guide_message" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "lead" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "listing_price_change" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "mail_message" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "notification" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "opportunity" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "phone_call" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "platform_view_log" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "property_watch_event" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "proposed_action" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "search_embedding" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "site_activity" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "sms_message" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "team_message" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "workflow_event" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
ALTER TABLE "workflow_run" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_search_trgm_idx" ON "contact" USING gin ((coalesce("name", '') || ' ' || coalesce("email", '') || ' ' || coalesce("phone", '') || ' ' || coalesce("address_suburb", '') || ' ' || coalesce("address_line", '')) extensions.gin_trgm_ops);