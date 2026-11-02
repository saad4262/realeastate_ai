-- ADR 0079: a customer's own address (where they live, not a property). Additive and idempotent: every
-- column is nullable, nothing is backfilled, and the deployed code does not read them.
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "address_line" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "address_suburb" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "address_state" varchar(8);--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "address_postcode" varchar(8);--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "address_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "address_longitude" numeric(9, 6);
