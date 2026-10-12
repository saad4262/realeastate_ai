CREATE TYPE "public"."appointment_kind" AS ENUM('client', 'team');--> statement-breakpoint
CREATE TABLE "appointment_participant" (
	"appointment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"declined_at" timestamp with time zone,
	CONSTRAINT "appointment_participant_appointment_id_user_id_pk" PRIMARY KEY("appointment_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "appointment" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "kind" "appointment_kind" DEFAULT 'client' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_participant" ADD CONSTRAINT "appointment_participant_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_participant" ADD CONSTRAINT "appointment_participant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_participant" ADD CONSTRAINT "appointment_participant_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_participant_user_idx" ON "appointment_participant" USING btree ("user_id","appointment_id");--> statement-breakpoint
-- Hand-written tail (ADR 0038). Every existing row is kind 'client' with a contact, so the CHECK holds.
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_kind_contact_check" CHECK (("kind" = 'client') = ("contact_id" IS NOT NULL));--> statement-breakpoint
-- Server-only (ADR 0017): no grants (default privileges revoked in 0019), RLS on.
ALTER TABLE "appointment_participant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The whole set: every tool allowed by 0041 plus schedule_team_meeting. No row changes.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'update_agent', 'remove_agent', 'send_email', 'message_colleagues', 'schedule_team_meeting'));
