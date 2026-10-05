CREATE TYPE "public"."skill_handler" AS ENUM('morning_brief', 'important_emails');--> statement-breakpoint
CREATE TYPE "public"."skill_model_tier" AS ENUM('summary', 'agent', 'hard');--> statement-breakpoint
CREATE TYPE "public"."skill_run_status" AS ENUM('running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."skill_run_trigger" AS ENUM('schedule', 'manual');--> statement-breakpoint
CREATE TABLE "agent_skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"body_md" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"email_me" boolean DEFAULT false NOT NULL,
	"cadence" "schedule_cadence" DEFAULT 'daily' NOT NULL,
	"send_at_minute" integer DEFAULT 420 NOT NULL,
	"send_on_weekday" integer,
	"interval_minutes" integer,
	"timezone" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid,
	"slug" varchar(80) NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"handler" "skill_handler" NOT NULL,
	"body_md" text NOT NULL,
	"requires" text[] DEFAULT '{}'::text[] NOT NULL,
	"model_tier" "skill_model_tier" DEFAULT 'summary' NOT NULL,
	"default_cadence" "schedule_cadence" DEFAULT 'daily' NOT NULL,
	"default_send_at_minute" integer DEFAULT 420 NOT NULL,
	"default_send_on_weekday" integer,
	"default_interval_minutes" integer,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_skill_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger" "skill_run_trigger" NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "skill_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" text,
	"summary_source" "summary_source" DEFAULT 'none' NOT NULL,
	"result" jsonb,
	"error" text,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"model" text,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_run" ADD CONSTRAINT "skill_run_agent_skill_id_agent_skill_id_fk" FOREIGN KEY ("agent_skill_id") REFERENCES "public"."agent_skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_run" ADD CONSTRAINT "skill_run_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_run" ADD CONSTRAINT "skill_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skill_user_skill_idx" ON "agent_skill" USING btree ("user_id","skill_id") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "agent_skill_due_idx" ON "agent_skill" USING btree ("next_run_at") WHERE enabled and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_scope_slug_idx" ON "skill" USING btree (coalesce("agency_id", '00000000-0000-0000-0000-000000000000'::uuid),"slug");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_run_slot_idx" ON "skill_run" USING btree ("agent_skill_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "skill_run_user_idx" ON "skill_run" USING btree ("user_id","created_at" desc);--> statement-breakpoint
-- Hand-written (ADR 0021). Server-only, like everything since ADR 0017.
ALTER TABLE "skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Times are minutes past midnight; an interval is at least an hour (the tick runs every 5 minutes).
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_minute_ok" CHECK (send_at_minute BETWEEN 0 AND 1439);--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_interval_ok" CHECK (interval_minutes IS NULL OR interval_minutes >= 60);--> statement-breakpoint
-- The platform library: the first two skills (agency_id null). Their bodies are
-- what an agent copies and edits; the handler is fixed in code.
INSERT INTO "skill" (slug, name, description, handler, body_md, requires, model_tier, default_cadence, default_send_at_minute)
VALUES
('morning-brief', 'Morning Brief',
 'Your day in one place: today''s appointments, overdue next actions, emails waiting for an answer and new leads — every point linked to its record.',
 'morning_brief',
 E'---\nrequires: []\nmodel: summary\nschedule: daily 07:00\n---\n\nWrite me a short morning brief from the records below.\n\n- Lead with what needs doing first today.\n- Mention any overdue next action by the person''s name.\n- Keep it to four sentences or fewer, plain and direct.\n- If there is nothing to do, say the day is clear.\n',
 '{}', 'summary', 'daily', 420),
('important-emails', '10 most important emails to answer',
 'Ranks the conversations waiting on you and says why each matters — offers and hot enquiries first, every reason tied to the email.',
 'important_emails',
 E'---\nrequires: []\nmodel: summary\nschedule: daily 08:00\n---\n\nRank the conversations below by how important it is that I answer them today.\n\n- Private offers and buyers ready to act come first.\n- Someone waiting a long time matters more than someone who wrote an hour ago.\n- Give one short reason for each, in plain words.\n- At most ten.\n',
 '{}', 'summary', 'daily', 480)
ON CONFLICT DO NOTHING;
