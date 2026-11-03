-- ADR 0080: a buyer's switch for one consumer skill, stored only where it differs from the catalog's default.
-- Additive and idempotent: a new table, nothing backfilled, and the deployed code does not read it.
CREATE TABLE IF NOT EXISTS "consumer_skill_switch" (
	"user_id" uuid NOT NULL,
	"skill_key" varchar(40) NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_skill_switch_user_id_skill_key_pk" PRIMARY KEY("user_id","skill_key")
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "consumer_skill_switch" ADD CONSTRAINT "consumer_skill_switch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "consumer_skill_switch" ENABLE ROW LEVEL SECURITY;
