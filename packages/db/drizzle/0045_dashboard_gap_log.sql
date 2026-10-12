CREATE TABLE "dashboard_gap_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid,
	"request" text NOT NULL,
	"nearest_dataset" varchar(40),
	"wanted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_gap_log" ADD CONSTRAINT "dashboard_gap_log_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_gap_log" ADD CONSTRAINT "dashboard_gap_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_gap_log_dataset_idx" ON "dashboard_gap_log" USING btree ("nearest_dataset","created_at" desc);--> statement-breakpoint
-- Hand-written tail (ADR 0036 Q2). Server-only (ADR 0017): no grants (default privileges revoked in 0019), RLS on.
ALTER TABLE "dashboard_gap_log" ENABLE ROW LEVEL SECURITY;
