-- ADR 0080, C5 decision 3: ABS Census 2021 housing figures per suburb — public reference data. Additive and
-- idempotent: a new table; its rows are loaded by `pnpm --filter @repo/db db:census` from data/census/.
CREATE TABLE IF NOT EXISTS "suburb_census" (
	"sal_code" varchar(12) PRIMARY KEY NOT NULL,
	"census_year" integer DEFAULT 2021 NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"state" varchar(8) NOT NULL,
	"population" integer,
	"dwellings" integer,
	"separate_houses" integer,
	"semi_detached" integer,
	"flats" integer,
	"owned_outright" integer,
	"owned_mortgage" integer,
	"rented" integer,
	"tenure_total" integer,
	"median_rent_weekly" integer,
	"median_mortgage_monthly" integer,
	"avg_household_size" numeric(4, 2)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suburb_census_state_name_idx" ON "suburb_census" USING btree ("state","name_key");--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "suburb_census" ENABLE ROW LEVEL SECURITY;
