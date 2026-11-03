-- ADR 0080, C4 Personal Property AI: what a buyer did to their profile — Forget everything, and their own edits.
-- Additive and idempotent: one new table, nothing backfilled, and the deployed code does not read it.
CREATE TABLE IF NOT EXISTS "buyer_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"forgotten_at" timestamp with time zone,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "buyer_profile" ADD CONSTRAINT "buyer_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "buyer_profile" ENABLE ROW LEVEL SECURITY;
