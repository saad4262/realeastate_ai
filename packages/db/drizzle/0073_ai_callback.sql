-- ADR 0072: the AI call back (Phase 3.3) — settings, each call's AI outcome, and the SIP trunk / Retell
-- registration. Additive. Idempotent like 0071/0072 (applied by hand ahead of the held 0069/0070).
ALTER TABLE "missed_call_setting" ADD COLUMN IF NOT EXISTS "ai_call_after_minutes" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "missed_call_setting" ADD COLUMN IF NOT EXISTS "calling_hours" jsonb DEFAULT '{"weekdays":[8,20],"saturday":[9,17],"sunday":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "missed_call_setting" ADD COLUMN IF NOT EXISTS "ai_calls_per_agent_day" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "missed_call_setting" ADD COLUMN IF NOT EXISTS "ai_calls_per_agency_day" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_account" ADD COLUMN IF NOT EXISTS "sip_trunk_sid" varchar(64);--> statement-breakpoint
ALTER TABLE "phone_account" ADD COLUMN IF NOT EXISTS "sip_domain" varchar(128);--> statement-breakpoint
ALTER TABLE "phone_account" ADD COLUMN IF NOT EXISTS "sip_username" varchar(64);--> statement-breakpoint
ALTER TABLE "phone_account" ADD COLUMN IF NOT EXISTS "sip_password" text;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_status" varchar(16);--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_reason" varchar(24);--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_call_id" varchar(64);--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_summary" text;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_transcript" text;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_recording_url" text;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_priority" varchar(8);--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_duration_s" integer;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "ai_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN IF NOT EXISTS "retell_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN IF NOT EXISTS "retell_error" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_call_ai_due_idx" ON "phone_call" USING btree ("ai_due_at") WHERE ai_status = 'scheduled';--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_ai_call_id_unique" UNIQUE("ai_call_id"); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;