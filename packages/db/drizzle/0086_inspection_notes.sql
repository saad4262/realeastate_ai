-- ADR 0080, C6 Inspection Assistant: a buyer's private notebook per home and its photos. Additive and idempotent:
-- two new tables, nothing backfilled, and the deployed code does not read them.
CREATE TABLE IF NOT EXISTS "inspection_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inspection_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_key" varchar(300) NOT NULL,
	"content_type" varchar(32) NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inspection_note" ADD CONSTRAINT "inspection_note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inspection_note" ADD CONSTRAINT "inspection_note_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inspection_photo" ADD CONSTRAINT "inspection_photo_note_id_inspection_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."inspection_note"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inspection_photo" ADD CONSTRAINT "inspection_photo_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inspection_note_user_listing_idx" ON "inspection_note" USING btree ("user_id","listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_note_user_idx" ON "inspection_note" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inspection_photo_key_idx" ON "inspection_photo" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_photo_note_idx" ON "inspection_photo" USING btree ("note_id","created_at");--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "inspection_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inspection_photo" ENABLE ROW LEVEL SECURITY;
