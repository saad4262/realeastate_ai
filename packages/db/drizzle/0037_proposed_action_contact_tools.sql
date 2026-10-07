-- Hand-written (ADR 0025 amendment, 2026-10-07: the assistant edits contacts).
-- Numbered 0037 and dated after feat/crm-rag's 0036 (assistant search, which does
-- not touch this table), so the two branches merge without renumbering. The list
-- below is the whole set: every tool allowed today plus the five new ones.
-- Widens the closed list of assistant tools that may be proposed to include the
-- contact tools: assign_contacts (owners/admins), record_marketing_consent,
-- withdraw_marketing_consent, update_contact and set_contact_archived. All five
-- are listed at once so the constraint changes once. No row changes: every
-- existing value stays allowed. Still a CHECK, so a typo in code cannot store
-- an unknown tool.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived'));
