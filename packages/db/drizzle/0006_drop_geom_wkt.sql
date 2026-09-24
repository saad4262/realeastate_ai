ALTER TABLE "property" DROP COLUMN "geom_wkt";--> statement-breakpoint
-- Everything past this line is PostGIS, which Drizzle cannot model and
-- therefore cannot regenerate. Hand-written on purpose; do not delete when
-- the next `drizzle-kit generate` runs.

-- Generated, not written.
--
-- geom_wkt above was a text placeholder nothing ever wrote to and nothing
-- could query — "within 5 km" cannot be asked of a string. Holding both a
-- lat/lng pair and a separate point would be two copies of one fact that
-- drift the first time an address is corrected, so Postgres derives this one
-- and keeps it in step. Every function in the expression is IMMUTABLE, which
-- is what allows STORED, which is what allows an index.
ALTER TABLE "property" ADD COLUMN IF NOT EXISTS "geom" geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE
      WHEN latitude IS NOT NULL AND longitude IS NOT NULL
      THEN ST_SetSRID(
             ST_MakePoint(longitude::double precision, latitude::double precision),
             4326
           )::geography
      ELSE NULL
    END
  ) STORED;--> statement-breakpoint

-- GiST, not btree: a radius search is an overlap test, not an ordering.
CREATE INDEX IF NOT EXISTS "property_geom_idx" ON "property" USING gist ("geom");--> statement-breakpoint

-- How a listing is found when it has no pin yet, and how every public search
-- narrows before it does anything else.
CREATE INDEX IF NOT EXISTS "property_suburb_lower_idx" ON "property" (lower("suburb"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_postcode_idx" ON "property" ("postcode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_status_channel_idx" ON "listing" ("status", "channel");--> statement-breakpoint

-- Nothing private is in place_cache — it caches a public gazetteer — but every
-- other table here has RLS on, and an exception would need explaining at every
-- audit. Reads go through the service role, which bypasses it.
ALTER TABLE "place_cache" ENABLE ROW LEVEL SECURITY;
