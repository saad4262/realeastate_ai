ALTER TABLE "agency" ADD COLUMN "sends_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "sends_paused_reason" text;