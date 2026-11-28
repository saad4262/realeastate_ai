-- ADR 0103: each workflow step looks up its run by task to see whether the person has replied. Additive and idempotent.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_task_id_idx" ON "workflow_run" USING btree ("task_id") WHERE task_id is not null;
