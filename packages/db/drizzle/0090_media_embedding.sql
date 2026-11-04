-- ADR 0080, C9 decisions 8–11: Visual Search's image vectors, one per listing photo (voyage-multimodal-3.5, 1024).
-- Additive and idempotent: one new table, empty until the embedding batch is switched on (off by default, the user's
-- call) or the backfill is run (the user's go). The deployed code does not read it.
CREATE TABLE IF NOT EXISTS "media_embedding" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"model" varchar(48) NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_embedding" ADD CONSTRAINT "media_embedding_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_embedding" ADD CONSTRAINT "media_embedding_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_embedding_listing_idx" ON "media_embedding" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_embedding_vector_idx" ON "media_embedding" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "media_embedding" ENABLE ROW LEVEL SECURITY;
