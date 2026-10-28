-- ADR 0060: a batch prepared from a listing's Matching buyers tab keeps the listing and its merge values, frozen at Prepare. Additive; null for every existing batch.
ALTER TABLE "email_batch" ADD COLUMN "listing_id" uuid;--> statement-breakpoint
ALTER TABLE "email_batch" ADD COLUMN "listing_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "email_batch" ADD CONSTRAINT "email_batch_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action;