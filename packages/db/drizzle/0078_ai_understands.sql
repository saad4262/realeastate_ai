-- ADR 0078 ("AI understands" every new enquiry). Additive and idempotent. The lead's three AI columns already
-- exist (empty); this adds urgency, the job's status and when, CHECKs their values, and lets the job find what is
-- waiting cheaply. Also widens proposed_action_tool_check: the two new tools, and switch_skill, which ADR 0058
-- added in code but never here (its card could not be saved).
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "ai_urgency" varchar(8);--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "ai_status" varchar(12);--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "ai_understood_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "lead" ADD CONSTRAINT "lead_ai_intent_check" CHECK (ai_intent IS NULL OR ai_intent IN ('buyer', 'seller', 'landlord', 'tenant', 'investor', 'general', 'not_sure')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "lead" ADD CONSTRAINT "lead_ai_urgency_check" CHECK (ai_urgency IS NULL OR ai_urgency IN ('high', 'normal')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "lead" ADD CONSTRAINT "lead_ai_status_check" CHECK (ai_status IS NULL OR ai_status IN ('done', 'not_sure', 'off', 'budget', 'no_text', 'failed')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- What the job picks up: leads it has not looked at yet, newest first.
CREATE INDEX IF NOT EXISTS "lead_ai_waiting_idx" ON "lead" USING btree ("created_at") WHERE ai_status IS NULL;--> statement-breakpoint
ALTER TABLE "proposed_action" DROP CONSTRAINT IF EXISTS "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'update_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'update_agent', 'remove_agent', 'send_email', 'message_colleagues', 'schedule_team_meeting', 'set_lead_status', 'assign_lead', 'create_lead', 'create_contact', 'plan_task', 'cancel_task', 'create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing', 'invite_agent', 'set_up_skill', 'change_skill', 'create_workflow', 'change_workflow', 'create_template', 'remind', 'draft_email', 'switch_skill', 'save_buyer_brief', 'propose_ai_brief'));
