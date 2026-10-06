CREATE TABLE "agency_google_place" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"place_id" text NOT NULL,
	"picked_by" uuid,
	"picked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency_google_place" ADD CONSTRAINT "agency_google_place_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_google_place" ADD CONSTRAINT "agency_google_place_picked_by_user_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_google_place_agency_idx" ON "agency_google_place" USING btree ("agency_id");--> statement-breakpoint
-- Server-only (ADR 0017): no grants, RLS on, nothing reachable from a browser.
ALTER TABLE "agency_google_place" ENABLE ROW LEVEL SECURITY;

