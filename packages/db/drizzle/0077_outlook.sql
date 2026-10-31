-- ADR 0076: Outlook mail and calendar beside Google's, and which one of each is active per owner. Additive and
-- idempotent. The new enum values are compared as text in the CHECKs below: a value added in this transaction
-- cannot be used as an enum literal in it (as 0034 did for gmail).
ALTER TYPE "public"."integration_provider" ADD VALUE IF NOT EXISTS 'outlook_mail';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE IF NOT EXISTS 'outlook_calendar';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_choice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"owner_type" "integration_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"chosen_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "integration_choice" ADD CONSTRAINT "integration_choice_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "integration_choice" ADD CONSTRAINT "integration_choice_chosen_by_user_id_fk" FOREIGN KEY ("chosen_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_choice_owner_idx" ON "integration_choice" USING btree ("agency_id","owner_type","owner_id","purpose");--> statement-breakpoint
-- Hand-written tail. A choice is for mail or calendar, and names a provider of that purpose.
DO $$ BEGIN ALTER TABLE "integration_choice" ADD CONSTRAINT "integration_choice_purpose_check" CHECK (
  (purpose = 'mail' AND provider::text IN ('gmail', 'outlook_mail'))
  OR (purpose = 'calendar' AND provider::text IN ('google_calendar', 'outlook_calendar'))
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Outlook mail may be a person's or the agency's (as Gmail); Outlook Calendar a person's (as Google Calendar).
-- Every existing combination stays exactly as before.
ALTER TABLE "integration_account" DROP CONSTRAINT IF EXISTS "integration_account_owner_type_ok";--> statement-breakpoint
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_owner_type_ok" CHECK (
  (provider::text IN ('google_calendar', 'outlook_calendar') AND owner_type = 'user')
  OR (provider::text = 'google_reviews' AND owner_type = 'agency')
  OR provider::text IN ('zoom', 'google_sheets', 'gmail', 'outlook_mail')
);--> statement-breakpoint
-- How a message left: the platform sender, a connected Gmail, or (ADR 0076) a connected Outlook.
ALTER TABLE "mail_message" DROP CONSTRAINT IF EXISTS "mail_message_sent_via_check";--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_sent_via_check" CHECK (sent_via IS NULL OR sent_via IN ('resend', 'gmail', 'outlook'));--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "integration_choice" ENABLE ROW LEVEL SECURITY;
