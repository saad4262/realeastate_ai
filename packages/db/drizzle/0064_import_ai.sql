-- ADR 0056: AI help for the contacts import — which mapped fields a model suggested, and whether the uploader asked for AI fixes. Additive; defaults keep every existing import as it was.
ALTER TABLE "listing_import" ADD COLUMN "ai_mapped" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_import" ADD COLUMN "ai_clean" boolean DEFAULT false NOT NULL;