-- ADR 0080, C4 Property Monitor: the addresses a buyer follows, and what happened at them. Additive and idempotent:
-- two new tables, nothing backfilled, and the deployed code does not read them.
CREATE TABLE IF NOT EXISTS "property_watch" (
	"user_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"time_zone" varchar(64) DEFAULT 'Australia/Sydney' NOT NULL,
	"seen_listing_id" uuid,
	"seen_status" varchar(16) DEFAULT 'none' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_watch_user_id_property_id_pk" PRIMARY KEY("user_id","property_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "property_watch_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"listing_id" uuid,
	"kind" varchar(24) NOT NULL,
	"text" text NOT NULL,
	"happened_at" timestamp with time zone NOT NULL,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "property_watch" ADD CONSTRAINT "property_watch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "property_watch" ADD CONSTRAINT "property_watch_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "property_watch" ADD CONSTRAINT "property_watch_seen_listing_id_listing_id_fk" FOREIGN KEY ("seen_listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "property_watch_event" ADD CONSTRAINT "property_watch_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "property_watch_event" ADD CONSTRAINT "property_watch_event_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "property_watch_event" ADD CONSTRAINT "property_watch_event_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_watch_checked_idx" ON "property_watch" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_watch_event_user_idx" ON "property_watch_event" USING btree ("user_id","emailed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_watch_event_property_idx" ON "property_watch_event" USING btree ("user_id","property_id","happened_at");--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "property_watch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "property_watch_event" ENABLE ROW LEVEL SECURITY;
