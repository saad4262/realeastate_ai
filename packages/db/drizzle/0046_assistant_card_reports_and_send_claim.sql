ALTER TABLE "mail_message" ADD COLUMN "send_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "send_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposed_action" ADD COLUMN "reported_at" timestamp with time zone;