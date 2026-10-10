-- Hand-written (ADR 0033, 2026-10-10: the assistant edits and removes team members).
-- Numbered 0040 and dated after feat/meetings' 0039 (which does not touch this
-- table): apply 0039 first, or the migrator will skip it as older than this one.
-- The list below is the whole set: every tool allowed by 0037 plus update_agent
-- and remove_agent. No row changes: every existing value stays allowed.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'update_agent', 'remove_agent'));
