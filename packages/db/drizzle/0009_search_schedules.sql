CREATE TYPE "public"."au_timezone" AS ENUM('Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Australia/Hobart', 'Australia/Darwin', 'Australia/Broken_Hill', 'Australia/Lord_Howe', 'Australia/Eucla');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."schedule_cadence" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."schedule_run_status" AS ENUM('running', 'delivered', 'empty', 'failed');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('active', 'paused', 'failing');--> statement-breakpoint
CREATE TYPE "public"."summary_source" AS ENUM('model', 'template', 'none');--> statement-breakpoint
CREATE TABLE "schedule_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "schedule_run_status" DEFAULT 'running' NOT NULL,
	"query" jsonb NOT NULL,
	"matched" integer,
	"new_count" integer,
	"listings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"listing_ids" uuid[],
	"summary" text,
	"summary_source" "summary_source" DEFAULT 'none' NOT NULL,
	"email_status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"emailed_at" timestamp with time zone,
	"email_error" text,
	"seen_at" timestamp with time zone,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"query" jsonb NOT NULL,
	"prompt_version" varchar(64) NOT NULL,
	"cadence" "schedule_cadence" DEFAULT 'daily' NOT NULL,
	"send_at_minute" integer NOT NULL,
	"send_on_weekday" integer,
	"timezone" "au_timezone" NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"status" "schedule_status" DEFAULT 'active' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_schedule_id_search_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."search_schedule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_schedule" ADD CONSTRAINT "search_schedule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_run_slot_idx" ON "schedule_run" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "schedule_run_user_idx" ON "schedule_run" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "search_schedule_due_idx" ON "search_schedule" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "search_schedule_user_idx" ON "search_schedule" USING btree ("user_id","created_at");--> statement-breakpoint

--
-- Everything past this line is hand-written and drizzle-kit will not
-- regenerate it. Do not delete it on the next `pnpm db:generate`.
--
-- The same arrangement as 0001_rls_extensions.sql, 0002 and 0006: drizzle
-- models tables and columns, and the security and the index predicates are
-- ours.
--

-- Make the due index partial.
--
-- The scan only ever wants active rows. A paused or failing schedule frozen at
-- a next_run_at in the past would otherwise sit at the front of the index for
-- good, and every tick would read past it. Drizzle can express `.where()` on
-- an index but does not emit it here, so the predicate is applied by hand and
-- packages/smoke asserts it is still there by reading pg_indexes.indexdef —
-- the name alone would not notice it going missing.
DROP INDEX IF EXISTS "search_schedule_due_idx";--> statement-breakpoint
CREATE INDEX "search_schedule_due_idx"
  ON "search_schedule" USING btree ("next_run_at")
  WHERE "status" = 'active';--> statement-breakpoint

-- ai_run has had no index since 0000, because nothing ever queried it. The
-- scheduler's spend budget is the first thing that does, and it asks for a sum
-- over a 24-hour window on every tick.
CREATE INDEX IF NOT EXISTS "ai_run_created_at_idx"
  ON "ai_run" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_run_feature_created_idx"
  ON "ai_run" USING btree ("feature", "created_at" DESC);--> statement-breakpoint

-- Row-level security.
--
-- Defence in depth, not the control. Every read in this app goes through the
-- pooler role, which bypasses RLS; can() in packages/core is what actually
-- decides. These policies are what stops a future anon-key read path from
-- being a data breach instead of a bug — and a saved search is a record of
-- what somebody is looking for and how much they can spend.
ALTER TABLE "search_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "search_schedule_select_own" ON "search_schedule"
  FOR SELECT USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "search_schedule_insert_own" ON "search_schedule"
  FOR INSERT WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "search_schedule_update_own" ON "search_schedule"
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "search_schedule_delete_own" ON "search_schedule"
  FOR DELETE USING (user_id = auth.uid());--> statement-breakpoint

-- SELECT only, deliberately. A run is written by the scheduler and by nothing
-- else, so there is no INSERT or UPDATE policy at all: a path that somehow
-- reached this table with a user's own credentials still could not forge a
-- delivery, or mark somebody else's alert as sent.
CREATE POLICY "schedule_run_select_own" ON "schedule_run"
  FOR SELECT USING (user_id = auth.uid());