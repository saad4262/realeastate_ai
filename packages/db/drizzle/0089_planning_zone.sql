-- ADR 0080, C9 decision 4: South Australia's Planning and Design Code zones (CC BY), public reference data for the
-- land-and-zoning panel. Additive and idempotent: one new table, empty until `pnpm --filter @repo/db db:zones` loads it.
-- The deployed code does not read it.
CREATE TABLE IF NOT EXISTS "planning_zone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" varchar(8) NOT NULL,
	"source" varchar(24) NOT NULL,
	"source_ref" varchar(64) NOT NULL,
	"zone_code" varchar(24) NOT NULL,
	"zone_name" text NOT NULL,
	"published_on" date NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_zone_source_idx" ON "planning_zone" USING btree ("source");--> statement-breakpoint
-- The polygon, by hand: Drizzle has no geometry type (as property.geom). Planar geometry in WGS84 — a point-in-polygon
-- test needs no geography, and the GiST index is what makes it one index probe.
ALTER TABLE "planning_zone" ADD COLUMN IF NOT EXISTS "geom" geometry(MultiPolygon, 4326) NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_zone_geom_idx" ON "planning_zone" USING gist ("geom");--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "planning_zone" ENABLE ROW LEVEL SECURITY;
