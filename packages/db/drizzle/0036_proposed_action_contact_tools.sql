-- Hand-written (ADR 0025 amendment, 2026-10-07: the assistant edits contacts).
-- Widens the closed list of assistant tools that may be proposed to include the
-- contact tools: assign_contacts (owners/admins), record_marketing_consent,
-- withdraw_marketing_consent, update_contact and set_contact_archived. All five
-- are listed at once so the constraint changes once. No row changes: every
-- existing value stays allowed. Still a CHECK, so a typo in code cannot store
-- an unknown tool.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived'));
