ALTER TABLE "place_cache" ADD COLUMN "unit" varchar(32);--> statement-breakpoint
ALTER TABLE "place_cache" ADD COLUMN "street_number" varchar(32);--> statement-breakpoint
ALTER TABLE "place_cache" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "formatted_address" text;