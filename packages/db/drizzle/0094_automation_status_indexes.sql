-- ADR 0088: an owner's Activity panel reads the agency's tasks and skill runs. Additive and idempotent.
CREATE INDEX IF NOT EXISTS "assistant_task_agency_idx" ON "assistant_task" USING btree ("agency_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_run_agency_idx" ON "skill_run" USING btree ("agency_id","created_at" desc);
