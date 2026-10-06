ALTER TABLE "appointment" ADD COLUMN "external_calendar_account_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "external_calendar_etag" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "calendar_sync_state" varchar(16);--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "calendar_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "calendar_sync_error" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "calendar_conflict" jsonb;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "calendar_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "zoom_account_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "zoom_sync_state" varchar(16);--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "zoom_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "zoom_sync_error" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "sync_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_external_calendar_account_id_integration_account_id_fk" FOREIGN KEY ("external_calendar_account_id") REFERENCES "public"."integration_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_zoom_account_id_integration_account_id_fk" FOREIGN KEY ("zoom_account_id") REFERENCES "public"."integration_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_calendar_sync_idx" ON "appointment" USING btree ("calendar_sync_state","starts_at") WHERE calendar_sync_state is not null;--> statement-breakpoint
-- Hand-written. The sync states are a closed list (packages/core/src/appointments/sync.ts).
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_calendar_sync_state_check" CHECK (calendar_sync_state IN ('pending', 'synced', 'failed', 'conflict', 'removed'));--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_zoom_sync_state_check" CHECK (zoom_sync_state IN ('pending', 'synced', 'failed', 'removed'));
