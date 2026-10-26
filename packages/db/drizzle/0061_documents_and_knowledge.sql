-- ADR 0053: documents on contacts and listings, the agency knowledge base, their searchable chunks,
-- and the mark that an inbound email's attachments were fetched. Additive: no existing row changes.
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"scope" varchar(16) DEFAULT 'record' NOT NULL,
	"contact_id" uuid,
	"property_id" uuid,
	"listing_id" uuid,
	"lead_id" uuid,
	"mail_message_id" uuid,
	"uploaded_by" uuid,
	"title" text NOT NULL,
	"kind" varchar(16) DEFAULT 'other' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"size_bytes" integer NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"waiting_until" timestamp with time zone,
	"error" text,
	"extracted_via" varchar(16),
	"extracted_text" text,
	"page_count" integer,
	"extracted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"page_from" integer NOT NULL,
	"page_to" integer NOT NULL,
	"text" text NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
	"model" varchar(64),
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "attachments_stored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_mail_message_id_mail_message_id_fk" FOREIGN KEY ("mail_message_id") REFERENCES "public"."mail_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_contact_idx" ON "document" USING btree ("contact_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "document_listing_idx" ON "document" USING btree ("listing_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "document_agency_scope_idx" ON "document" USING btree ("agency_id","scope","created_at" desc);--> statement-breakpoint
CREATE INDEX "document_pending_idx" ON "document" USING btree ("status","created_at") WHERE status in ('pending', 'extracting');--> statement-breakpoint
CREATE UNIQUE INDEX "document_storage_key_idx" ON "document" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunk_doc_idx" ON "document_chunk" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_chunk_agency_idx" ON "document_chunk" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "document_chunk_search_idx" ON "document_chunk" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "document_chunk_vector_idx" ON "document_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_chunk" ENABLE ROW LEVEL SECURITY;
