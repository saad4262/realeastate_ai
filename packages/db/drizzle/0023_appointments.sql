CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'completed', 'cancelled', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."appointment_type" AS ENUM('appraisal', 'phone_call', 'zoom', 'inspection', 'meeting');--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid,
	"created_by" uuid,
	"assigned_agent_id" uuid,
	"title" text NOT NULL,
	"type" "appointment_type" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"location" text,
	"meeting_url" text,
	"notes" text,
	"outcome" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminder_minutes" integer,
	"invitation_sent_at" timestamp with time zone,
	"external_calendar_id" text,
	"external_calendar_provider" varchar(32),
	"zoom_meeting_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "kind" varchar(32);--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_assigned_agent_id_user_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_agency_starts_idx" ON "appointment" USING btree ("agency_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_contact_starts_idx" ON "appointment" USING btree ("contact_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_agent_starts_idx" ON "appointment" USING btree ("assigned_agent_id","starts_at");--> statement-breakpoint
-- Hand-written. An appointment ends after it starts.
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_ends_after_starts" CHECK (ends_at > starts_at);--> statement-breakpoint
-- Server-only, like everything since 0019 (ADR 0017): RLS on, no policies.
ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;
