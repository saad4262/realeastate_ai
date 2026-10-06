CREATE TABLE "proposed_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid,
	"contact_id" uuid,
	"tool" varchar(48) NOT NULL,
	"args" jsonb NOT NULL,
	"card" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'proposed' NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"finished_at" timestamp with time zone,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposed_action_idempotency_idx" ON "proposed_action" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "proposed_action_user_idx" ON "proposed_action" USING btree ("user_id","created_at" desc);--> statement-breakpoint
-- Hand-written. RLS on, no grants (ADR 0017).
ALTER TABLE "proposed_action" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Closed lists (packages/core/src/assistant/schema.ts).
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_status_check" CHECK (status IN ('proposed', 'approved', 'rejected', 'expired', 'scheduled', 'running', 'done', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email'));--> statement-breakpoint
-- The cron tick expires proposals nobody decided within 48 h.
CREATE INDEX IF NOT EXISTS "proposed_action_expiry_idx" ON "proposed_action" USING btree ("expires_at") WHERE status = 'proposed';
