ALTER TABLE "workflow_event" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_event" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "workflow_event" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_event" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workflow_event_failed_idx" ON "workflow_event" USING btree ("failed_at" desc) WHERE failed_at is not null;