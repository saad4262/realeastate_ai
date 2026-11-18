CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid,
	"kind" varchar(48) NOT NULL,
	"lane" varchar(12) DEFAULT 'send' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_ready_idx" ON "job" USING btree ("lane","run_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "job_running_idx" ON "job" USING btree ("claimed_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "job_dead_idx" ON "job" USING btree ("finished_at" desc) WHERE status = 'dead';--> statement-breakpoint
CREATE INDEX "job_agency_idx" ON "job" USING btree ("agency_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupe_idx" ON "job" USING btree ("kind","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
-- Hand-written tail: a server-only table (ADR 0017): RLS on, no policy, no browser grant.
ALTER TABLE "job" ENABLE ROW LEVEL SECURITY;
