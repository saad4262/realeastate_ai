ALTER TABLE "listing_import" ADD COLUMN "kind" varchar(16) DEFAULT 'listings' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_import" ADD COLUMN "source" varchar(16) DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_import" ADD COLUMN "source_ref" jsonb;--> statement-breakpoint
ALTER TABLE "listing_import_row" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "listing_import_row" ADD CONSTRAINT "listing_import_row_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_import" ADD CONSTRAINT "listing_import_source_check" CHECK (source IN ('csv', 'xlsx', 'sheet'));--> statement-breakpoint
ALTER TABLE "listing_import" ADD CONSTRAINT "listing_import_kind_check" CHECK (kind IN ('listings', 'contacts'));
