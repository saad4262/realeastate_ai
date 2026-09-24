CREATE TABLE "place_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lookup_key" text NOT NULL,
	"provider" varchar(32) DEFAULT 'google' NOT NULL,
	"place_id" text,
	"formatted" text NOT NULL,
	"suburb" text,
	"state" varchar(8),
	"postcode" varchar(8),
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"kind" varchar(32) DEFAULT 'address' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "place_id" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "geocoded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "geocode_source" varchar(32);--> statement-breakpoint
CREATE UNIQUE INDEX "place_cache_lookup_key_idx" ON "place_cache" USING btree ("lookup_key");