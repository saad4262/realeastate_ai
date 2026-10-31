-- ADR 0075: one address, several agencies. A listing keeps the facts its own ad states (the shared property
-- row is never rewritten by a listing), and each agency may have its own open deal on an address.
-- Additive and idempotent. The backfill copies each existing listing's facts from its address once — only a
-- listing whose facts are all still empty — so every ad already live keeps exactly what it shows today.
ALTER TABLE "listing" ADD COLUMN IF NOT EXISTS "property_type" varchar(64);--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN IF NOT EXISTS "bedrooms" integer;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN IF NOT EXISTS "bathrooms" numeric(3, 1);--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN IF NOT EXISTS "car_spaces" integer;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN IF NOT EXISTS "land_area_sqm" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN IF NOT EXISTS "building_area_sqm" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN IF NOT EXISTS "year_built" integer;--> statement-breakpoint
UPDATE "listing" l SET
	"property_type" = p."property_type",
	"bedrooms" = p."bedrooms",
	"bathrooms" = p."bathrooms",
	"car_spaces" = p."car_spaces",
	"land_area_sqm" = p."land_area_sqm",
	"building_area_sqm" = p."building_area_sqm",
	"year_built" = p."year_built"
FROM "property" p
WHERE p."id" = l."property_id"
	AND l."property_type" IS NULL AND l."bedrooms" IS NULL AND l."bathrooms" IS NULL AND l."car_spaces" IS NULL
	AND l."land_area_sqm" IS NULL AND l."building_area_sqm" IS NULL AND l."year_built" IS NULL;--> statement-breakpoint
-- The per-agency index is added here; the old one-per-address index is dropped by 0076 only AFTER the code
-- that names the new one in ON CONFLICT is deployed (the old code's ON CONFLICT needs the old index).
CREATE UNIQUE INDEX IF NOT EXISTS "deal_open_agency_property_idx" ON "deal" USING btree ("agency_id","property_id") WHERE status = 'open';
