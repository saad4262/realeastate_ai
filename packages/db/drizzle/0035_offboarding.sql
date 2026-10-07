ALTER TABLE "appointment" ADD COLUMN "needs_owner_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "needs_owner_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_account" ADD COLUMN "connector_left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "needs_owner_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "needs_owner_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "removed_by" uuid;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "removal_report" jsonb;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_one_active_idx" ON "membership" USING btree ("user_id") WHERE status = 'active';