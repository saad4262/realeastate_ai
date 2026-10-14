CREATE TABLE "workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"scope" varchar(8) DEFAULT 'mine' NOT NULL,
	"name" varchar(80) NOT NULL,
	"spec" jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"listing_id" uuid,
	"appointment_id" uuid,
	"actor_id" uuid,
	"origin" varchar(12) DEFAULT 'person' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"event_id" uuid,
	"status" varchar(12) DEFAULT 'started' NOT NULL,
	"task_id" uuid,
	"contact_id" uuid,
	"lead_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposed_action" ADD COLUMN "origin" varchar(12) DEFAULT 'assistant' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_event_id_workflow_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."workflow_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_task_id_assistant_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."assistant_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_agency_idx" ON "workflow" USING btree ("agency_id","status");--> statement-breakpoint
CREATE INDEX "workflow_owner_idx" ON "workflow" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "workflow_event_pending_idx" ON "workflow_event" USING btree ("occurred_at") WHERE processed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_event_dedupe_idx" ON "workflow_event" USING btree ("agency_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_once_idx" ON "workflow_run" USING btree ("workflow_id","event_id");--> statement-breakpoint
CREATE INDEX "workflow_run_recent_idx" ON "workflow_run" USING btree ("workflow_id","created_at" desc);--> statement-breakpoint
-- Hand-written tail (ADR 0041 Part B). Server-only (ADR 0017): no grants (default privileges revoked in 0019), RLS on.
ALTER TABLE "workflow" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_scope_check" CHECK (scope IN ('mine', 'agency'));--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_status_check" CHECK (status IN ('active', 'paused', 'archived'));--> statement-breakpoint
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_origin_check" CHECK (origin IN ('person', 'website', 'workflow', 'system'));--> statement-breakpoint
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_kind_check" CHECK (kind IN ('lead.created', 'lead.status_changed', 'lead.no_reply', 'appointment.booked', 'listing.status_changed', 'contact.created'));--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_status_check" CHECK (status IN ('started', 'skipped', 'failed'));--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_origin_check" CHECK (origin IN ('assistant', 'workflow'));

--> statement-breakpoint
-- The tool CHECK holds exactly PROPOSED_ACTION_TOOLS: + create_workflow, change_workflow (cards) and draft_email (a workflow step).
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'update_agent', 'remove_agent', 'send_email', 'message_colleagues', 'schedule_team_meeting', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact', 'plan_task', 'cancel_task', 'create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing', 'invite_agent', 'set_up_skill', 'change_skill', 'create_workflow', 'change_workflow', 'remind', 'draft_email'));
