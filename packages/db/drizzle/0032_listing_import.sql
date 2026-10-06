CREATE TABLE "listing_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_by" uuid,
	"file_name" text NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"file_text" text,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'mapped' NOT NULL,
	"mode" varchar(16) DEFAULT 'pending' NOT NULL,
	"update_duplicates" boolean DEFAULT false NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_import_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb,
	"normalized" jsonb,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_of_listing_id" uuid,
	"listing_id" uuid,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "listing_import" ADD CONSTRAINT "listing_import_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_import" ADD CONSTRAINT "listing_import_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_import_row" ADD CONSTRAINT "listing_import_row_import_id_listing_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."listing_import"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_import_row" ADD CONSTRAINT "listing_import_row_duplicate_of_listing_id_listing_id_fk" FOREIGN KEY ("duplicate_of_listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_import_row" ADD CONSTRAINT "listing_import_row_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_import_agency_idx" ON "listing_import" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "listing_import_row_number_idx" ON "listing_import_row" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "listing_import_row_status_idx" ON "listing_import_row" USING btree ("import_id","status");--> statement-breakpoint
-- Hand-written. RLS on, no grants (ADR 0017).
ALTER TABLE "listing_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "listing_import_row" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "listing_import" ADD CONSTRAINT "listing_import_status_check" CHECK (status IN ('mapped', 'validating', 'validated', 'importing', 'done', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "listing_import" ADD CONSTRAINT "listing_import_mode_check" CHECK (mode IN ('live', 'draft', 'pending'));--> statement-breakpoint
ALTER TABLE "listing_import_row" ADD CONSTRAINT "listing_import_row_status_check" CHECK (status IN ('pending', 'valid', 'error', 'duplicate', 'imported', 'updated', 'failed', 'skipped'));--> statement-breakpoint
-- The agency's own listing id is unique within the agency (re-import updates, never duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS "listing_agency_external_id_idx" ON "listing" USING btree ("agency_id", "external_id") WHERE external_id IS NOT NULL;
