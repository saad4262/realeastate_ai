ALTER TABLE "contact" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;