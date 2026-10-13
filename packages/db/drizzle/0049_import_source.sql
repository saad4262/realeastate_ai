ALTER TABLE "listing_import" ADD COLUMN "source" varchar(16) DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_import" ADD COLUMN "source_ref" jsonb;--> statement-breakpoint
ALTER TABLE "listing_import" ADD CONSTRAINT "listing_import_source_check" CHECK (source IN ('csv', 'xlsx', 'sheet'));
