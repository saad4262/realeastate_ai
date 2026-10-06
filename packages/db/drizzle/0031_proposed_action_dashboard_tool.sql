-- Hand-written (ADR 0027 / 0025 Phase F). Widens the closed list of assistant
-- tools that may be proposed to include `create_dashboard`. No row changes:
-- every existing value stays allowed. The list stays a CHECK so a typo in code
-- cannot store an unknown tool.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard'));
