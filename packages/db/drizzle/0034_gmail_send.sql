ALTER TYPE "public"."integration_provider" ADD VALUE 'gmail';--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "members_may_use_agency_gmail" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "sent_via" varchar(16);--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "sender_account_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_sender_account_id_integration_account_id_fk" FOREIGN KEY ("sender_account_id") REFERENCES "public"."integration_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-written (ADR 0026). How a message left: the platform sender or a connected Gmail.
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_sent_via_check" CHECK (sent_via IS NULL OR sent_via IN ('resend', 'gmail'));--> statement-breakpoint
-- Gmail may be a person's or the agency's (ADR 0026 §1). The owner rule is widened to
-- allow it; every existing combination stays exactly as before (no row changes).
-- Compared as text: the enum value added above cannot be used as an enum literal in the
-- same transaction it was added in.
ALTER TABLE "integration_account" DROP CONSTRAINT "integration_account_owner_type_ok";--> statement-breakpoint
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_owner_type_ok" CHECK (
  (provider::text = 'google_calendar' AND owner_type = 'user')
  OR (provider::text = 'google_reviews' AND owner_type = 'agency')
  OR provider::text IN ('zoom', 'google_sheets', 'gmail')
);
