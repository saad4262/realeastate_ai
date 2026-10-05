CREATE TYPE "public"."integration_owner_type" AS ENUM('user', 'agency');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('google_calendar', 'zoom', 'google_sheets', 'google_reviews');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'expired', 'error', 'permission_missing');--> statement-breakpoint
CREATE TABLE "integration_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"owner_type" "integration_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"external_account_label" text,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "integration_status" NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_account_owner_idx" ON "integration_account" USING btree ("provider","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "integration_account_agency_idx" ON "integration_account" USING btree ("agency_id");--> statement-breakpoint
-- Hand-written (ADR 0020). Which owners a provider allows: a calendar is a
-- person's, reviews are the agency's, Zoom and Sheets may be either. The same
-- rule is PROVIDERS in packages/core/src/integrations/providers.ts.
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_owner_type_ok" CHECK (
  (provider = 'google_calendar' AND owner_type = 'user')
  OR (provider = 'google_reviews' AND owner_type = 'agency')
  OR provider IN ('zoom', 'google_sheets')
);--> statement-breakpoint
-- An agency-level account is owned by its own agency.
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_agency_owner" CHECK (
  owner_type = 'user' OR owner_id = agency_id
);--> statement-breakpoint
-- Server-only (ADR 0017): RLS on, no policies, no grants. Tokens never reach a browser key.
ALTER TABLE "integration_account" ENABLE ROW LEVEL SECURITY;
