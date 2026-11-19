-- PLATFORM-PLAN 1.10 (D1): foreign keys that a hot read filters on, or that a delete walks on a table that grows.
-- Every tenant table's agency_id (agency reads, agency deletion). Additive and idempotent. Plain CREATE INDEX is
-- fine while the tables are small (before the first agency); on a big table use the concurrent script (DEPLOY.md).
CREATE INDEX IF NOT EXISTS "activity_agency_id_fk_idx" ON "activity" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_invite_agency_id_fk_idx" ON "agent_invite" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skill_agency_id_fk_idx" ON "agent_skill" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_query_ticket_agency_id_fk_idx" ON "ai_query_ticket" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_participant_agency_id_fk_idx" ON "appointment_participant" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_conversation_agency_id_fk_idx" ON "assistant_conversation" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_task_conversation_id_fk_idx" ON "assistant_task" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_conversation_id_fk_idx" ON "automation" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_assigned_to_fk_idx" ON "contact" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_filter_agency_id_fk_idx" ON "contact_filter" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_gap_log_agency_id_fk_idx" ON "dashboard_gap_log" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_condition_agency_id_fk_idx" ON "deal_condition" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_event_agency_id_fk_idx" ON "deal_event" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_batch_recipient_sms_message_id_fk_idx" ON "email_batch_recipient" USING btree ("sms_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_note_listing_id_fk_idx" ON "inspection_note" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_listing_id_fk_idx" ON "lead" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_assigned_to_fk_idx" ON "lead" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_user_id_fk_idx" ON "lead" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_agent_user_id_fk_idx" ON "listing_agent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_price_change_agency_id_fk_idx" ON "listing_price_change" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_listing_id_fk_idx" ON "media" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_agency_id_fk_idx" ON "membership" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "note_agency_id_fk_idx" ON "note" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_agency_id_fk_idx" ON "notification" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "office_agency_id_fk_idx" ON "office" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_watch_property_id_fk_idx" ON "property_watch" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_watch_event_property_id_fk_idx" ON "property_watch_event" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposed_action_conversation_id_fk_idx" ON "proposed_action" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shortlist_listing_id_fk_idx" ON "shortlist" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_activity_listing_id_fk_idx" ON "site_activity" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_agency_id_fk_idx" ON "skill" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_read_agency_id_fk_idx" ON "sms_read" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_agency_id_fk_idx" ON "team" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_message_agency_id_fk_idx" ON "team_message" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_event_id_fk_idx" ON "workflow_run" USING btree ("event_id");