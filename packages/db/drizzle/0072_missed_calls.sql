-- ADR 0071: missed calls (Phase 3.2) — the agency's missed-call settings, and what was done about each
-- missed call. Additive. Idempotent like 0071, which was applied by hand ahead of the held 0069/0070.
CREATE TABLE IF NOT EXISTS "missed_call_setting" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"greeting" text NOT NULL,
	"sms_template" text NOT NULL,
	"texts_per_agent_day" integer NOT NULL,
	"texts_per_agency_day" integer NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "outcome" varchar(16);--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "sms_message_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "handled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_call" ADD COLUMN IF NOT EXISTS "handled_by" uuid;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "missed_call_setting" ADD CONSTRAINT "missed_call_setting_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "missed_call_setting" ADD CONSTRAINT "missed_call_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_sms_message_id_sms_message_id_fk" FOREIGN KEY ("sms_message_id") REFERENCES "public"."sms_message"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_call_agency_missed_idx" ON "phone_call" USING btree ("agency_id","created_at" desc) WHERE kind = 'missed';
--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "missed_call_setting" ENABLE ROW LEVEL SECURITY;
