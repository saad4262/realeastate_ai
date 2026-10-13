CREATE TABLE "assistant_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"title" text NOT NULL,
	"status" varchar(16) DEFAULT 'proposed' NOT NULL,
	"error" text,
	"ends_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "source" varchar(16) DEFAULT 'website' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposed_action" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "proposed_action" ADD COLUMN "task_seq" integer;--> statement-breakpoint
ALTER TABLE "assistant_task" ADD CONSTRAINT "assistant_task_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_task" ADD CONSTRAINT "assistant_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_task" ADD CONSTRAINT "assistant_task_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_task_user_idx" ON "assistant_task" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_task_id_assistant_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."assistant_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written tail (ADR 0040). Server-only (ADR 0017): no grants (default privileges revoked in 0019), RLS on.
ALTER TABLE "assistant_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_task" ADD CONSTRAINT "assistant_task_status_check" CHECK (status IN ('proposed', 'active', 'done', 'failed', 'cancelled', 'expired'));--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_source_check" CHECK (source IN ('website', 'manual'));--> statement-breakpoint
CREATE INDEX "proposed_action_task_idx" ON "proposed_action" USING btree ("task_id","task_seq") WHERE task_id IS NOT NULL;--> statement-breakpoint
-- A task step waits as 'blocked' until the step before it is done. Every other status as 0029.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_status_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_status_check" CHECK (status IN ('proposed', 'approved', 'rejected', 'expired', 'scheduled', 'running', 'done', 'failed', 'cancelled', 'blocked'));--> statement-breakpoint
-- The whole set: every tool allowed by 0044 plus ADR 0040's. No row changes.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'update_agent', 'remove_agent', 'send_email', 'message_colleagues', 'schedule_team_meeting', 'plan_task', 'cancel_task', 'remind', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact'));
