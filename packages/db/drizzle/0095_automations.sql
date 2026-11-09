-- ADR 0089: repeating automations and their runs. Two new tables; nothing existing is changed.
CREATE TABLE "automation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"skill_key" varchar(48) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"cadence" "schedule_cadence" NOT NULL,
	"send_at_minute" integer DEFAULT 420 NOT NULL,
	"send_on_weekday" integer,
	"interval_minutes" integer,
	"timezone" text NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger" varchar(12) DEFAULT 'schedule' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" varchar(12) DEFAULT 'running' NOT NULL,
	"contact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"lease_until" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_due_idx" ON "automation" USING btree ("next_run_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "automation_agency_idx" ON "automation" USING btree ("agency_id","status");--> statement-breakpoint
CREATE INDEX "automation_user_idx" ON "automation" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_slot_idx" ON "automation_run" USING btree ("automation_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "automation_run_recent_idx" ON "automation_run" USING btree ("automation_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "automation_run_agency_idx" ON "automation_run" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "automation_run_running_idx" ON "automation_run" USING btree ("lease_until") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "automation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_run" ENABLE ROW LEVEL SECURITY;
