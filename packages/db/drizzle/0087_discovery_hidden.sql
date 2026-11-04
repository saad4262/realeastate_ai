-- ADR 0080, C7 Discovery AI: "Not for me" — an address a buyer asked not to be suggested again. Additive and
-- idempotent: one new table, nothing backfilled, and the deployed code does not read it.
CREATE TABLE IF NOT EXISTS "discovery_hidden" (
	"user_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_hidden_user_id_property_id_pk" PRIMARY KEY("user_id","property_id")
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "discovery_hidden" ADD CONSTRAINT "discovery_hidden_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "discovery_hidden" ADD CONSTRAINT "discovery_hidden_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "discovery_hidden" ENABLE ROW LEVEL SECURITY;
