CREATE TABLE "ai_credit_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"used" numeric(14, 4) DEFAULT '0' NOT NULL,
	"source" varchar(8) NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"stripe_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_grant_stripe_ref_unique" UNIQUE("stripe_ref")
);
--> statement-breakpoint
CREATE TABLE "ai_credit_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" varchar(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "billing_status" varchar(12);--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_run" ADD COLUMN "credit_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_credit_grant" ADD CONSTRAINT "ai_credit_grant_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_hold" ADD CONSTRAINT "ai_credit_hold_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_credit_grant_agency_idx" ON "ai_credit_grant" USING btree ("agency_id","expires_at");--> statement-breakpoint
CREATE INDEX "ai_credit_hold_agency_idx" ON "ai_credit_hold" USING btree ("agency_id","expires_at");--> statement-breakpoint
ALTER TABLE "agency" ADD CONSTRAINT "agency_stripe_customer_id_unique" UNIQUE("stripe_customer_id");--> statement-breakpoint
-- Hand-written tail (ADR 0092). Server-only tables (ADR 0017): RLS on, no policy, no browser grant.
ALTER TABLE "ai_credit_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_credit_hold" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The settlement tick reads only runs not yet settled (ai_run is small at V1, so a plain CREATE INDEX).
CREATE INDEX IF NOT EXISTS "ai_run_unsettled_idx" ON "ai_run" USING btree ("agency_id") WHERE credit_settled_at IS NULL AND agency_id IS NOT NULL;
