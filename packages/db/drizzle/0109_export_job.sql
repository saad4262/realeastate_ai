-- ADR 0104 phase 3: a member's full data export. A new table only: nothing existing is locked or rewritten.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
CREATE TABLE "export_job" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"cursor" text,
	"objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "export_job_user_idx" ON "export_job" USING btree ("agency_id","user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "export_job_expiry_idx" ON "export_job" USING btree ("expires_at") WHERE status = 'ready';--> statement-breakpoint
-- Hand-written tail: a server-only table (ADR 0017): RLS on, no policy, no browser grant.
ALTER TABLE "export_job" ENABLE ROW LEVEL SECURITY;
