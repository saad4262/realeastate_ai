-- ADR 0080, C8 Acting for the buyer. Additive and idempotent: two enum values (a one-off task's cadence and its done
-- state — never used in this file, so the ADD VALUE is safe inside the migration's transaction), three columns on
-- search_schedule (kind, sections, skip_empty: every existing row stays an `alert`), one on schedule_run (report), and
-- three owner-only tables. Nothing backfilled; the deployed code does not read any of it.
ALTER TYPE "public"."schedule_cadence" ADD VALUE IF NOT EXISTS 'once';--> statement-breakpoint
ALTER TYPE "public"."schedule_status" ADD VALUE IF NOT EXISTS 'done';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid,
	"property_id" uuid,
	"dedupe_key" varchar(120) NOT NULL,
	"text" text NOT NULL,
	"action_taken" varchar(12),
	"undo" jsonb,
	"undone_at" timestamp with time zone,
	"happened_at" timestamp with time zone NOT NULL,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buyer_automation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger" varchar(24) NOT NULL,
	"scope" varchar(12) NOT NULL,
	"search_id" uuid,
	"action" varchar(24) NOT NULL,
	"delivery" varchar(12) DEFAULT 'daily' NOT NULL,
	"time_zone" varchar(64) DEFAULT 'Australia/Sydney' NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guide_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid,
	"lead_id" uuid,
	"thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_run" ADD COLUMN IF NOT EXISTS "report" jsonb;--> statement-breakpoint
ALTER TABLE "search_schedule" ADD COLUMN IF NOT EXISTS "kind" varchar(8) DEFAULT 'alert' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_schedule" ADD COLUMN IF NOT EXISTS "sections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "search_schedule" ADD COLUMN IF NOT EXISTS "skip_empty" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_automation_id_buyer_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."buyer_automation"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "buyer_automation" ADD CONSTRAINT "buyer_automation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "buyer_automation" ADD CONSTRAINT "buyer_automation_search_id_search_schedule_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."search_schedule"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "guide_message" ADD CONSTRAINT "guide_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "guide_message" ADD CONSTRAINT "guide_message_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "guide_message" ADD CONSTRAINT "guide_message_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "guide_message" ADD CONSTRAINT "guide_message_thread_id_mail_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_thread"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "automation_event_dedupe_idx" ON "automation_event" USING btree ("automation_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_event_user_idx" ON "automation_event" USING btree ("user_id","emailed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_event_log_idx" ON "automation_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buyer_automation_user_idx" ON "buyer_automation" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buyer_automation_due_idx" ON "buyer_automation" USING btree ("status","checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guide_message_user_idx" ON "guide_message" USING btree ("user_id","created_at");--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "buyer_automation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "guide_message" ENABLE ROW LEVEL SECURITY;
