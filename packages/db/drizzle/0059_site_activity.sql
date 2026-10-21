-- ADR 0051: public-site searches and listing views for the admin Users section.
CREATE TABLE "site_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" varchar(16) NOT NULL,
	"suburb" text,
	"state" varchar(8),
	"channel" varchar(16),
	"listing_id" uuid,
	"agency_id" uuid,
	"query" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_activity" ADD CONSTRAINT "site_activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_activity" ADD CONSTRAINT "site_activity_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_activity" ADD CONSTRAINT "site_activity_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_activity_user_idx" ON "site_activity" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "site_activity_created_idx" ON "site_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "site_activity_agency_idx" ON "site_activity" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "site_activity" ENABLE ROW LEVEL SECURITY;
