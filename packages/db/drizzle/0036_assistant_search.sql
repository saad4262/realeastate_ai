-- Hand-written (ADR 0031). pgvector lives in Supabase's `extensions` schema (already on in dev;
-- this line is for a fresh database). Additive only: one table, three generated columns, indexes.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;--> statement-breakpoint
CREATE TABLE "search_embedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"source_kind" varchar(16) NOT NULL,
	"source_id" uuid NOT NULL,
	"contact_id" uuid,
	"chunk_index" integer NOT NULL,
	"content_hash" text NOT NULL,
	"model" varchar(64) NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(message, ''))) STORED;--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(text, ''))) STORED;--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;--> statement-breakpoint
ALTER TABLE "search_embedding" ADD CONSTRAINT "search_embedding_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_embedding" ADD CONSTRAINT "search_embedding_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_embedding_source_idx" ON "search_embedding" USING btree ("source_kind","source_id","chunk_index");--> statement-breakpoint
CREATE INDEX "search_embedding_agency_idx" ON "search_embedding" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "search_embedding_vector_idx" ON "search_embedding" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "lead_search_idx" ON "lead" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "mail_message_search_idx" ON "mail_message" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "note_search_idx" ON "note" USING gin ("search_tsv");--> statement-breakpoint
ALTER TABLE "search_embedding" ADD CONSTRAINT "search_embedding_source_kind_check" CHECK (source_kind IN ('note', 'email', 'enquiry'));--> statement-breakpoint
-- Server-only (ADR 0017): no grants, RLS on, nothing reachable from a browser.
ALTER TABLE "search_embedding" ENABLE ROW LEVEL SECURITY;
