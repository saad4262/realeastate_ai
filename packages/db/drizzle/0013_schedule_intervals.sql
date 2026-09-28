ALTER TYPE "public"."schedule_cadence" ADD VALUE 'interval';--> statement-breakpoint
ALTER TABLE "search_schedule" ADD COLUMN "interval_minutes" integer;