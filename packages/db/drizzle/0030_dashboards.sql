CREATE TABLE "dashboard" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"widgets" jsonb NOT NULL,
	"audience" varchar(16) DEFAULT 'admins' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "time_zone" text DEFAULT 'Australia/Sydney' NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_agency_idx" ON "dashboard" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
-- Hand-written. RLS on, no grants (ADR 0017).
ALTER TABLE "dashboard" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_audience_check" CHECK (audience IN ('private', 'admins', 'agency'));
