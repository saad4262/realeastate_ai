-- ADR 0091: the Control Centre reads an agency's runs, opportunities and waiting cards. Additive and idempotent.
CREATE INDEX IF NOT EXISTS "opportunity_agency_idx" ON "opportunity" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposed_action_waiting_idx" ON "proposed_action" USING btree ("agency_id") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_agency_idx" ON "workflow_run" USING btree ("agency_id","created_at" desc);