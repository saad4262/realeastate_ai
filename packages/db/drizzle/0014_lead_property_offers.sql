-- A lead is anchored to a property, and one kind of lead is a private offer.
-- See docs/adr/0012.
--
-- Two things about this file are deliberate and easy to undo by accident.
--
-- 1. `property_id` is added NULLABLE, backfilled, and only then made NOT NULL.
--    drizzle-kit generates this as a single `ADD COLUMN ... NOT NULL`, which
--    fails on any non-empty `lead`. The end state is identical, so the next
--    `db:generate` sees no drift.
--
-- 2. Nothing here may mention the literal 'offer'. `drizzle-kit migrate` runs
--    the whole pending set inside one transaction, and Postgres forbids USING
--    a new enum value in the transaction that added it. So no
--    `CHECK (kind <> 'offer' OR ...)`, no partial index on `kind = 'offer'`,
--    and no such default — each would fail here and again on a fresh migrate
--    from zero. Those rules live in createPrivateOffer instead, which is also
--    where `kind` and `status` were already being set rather than trusted.
ALTER TYPE "public"."lead_kind" ADD VALUE 'offer';--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "property_id" uuid;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "offer_amount" numeric(14, 2);--> statement-breakpoint
-- Total by construction: listing_id was NOT NULL until the next statement, and
-- every listing has a property_id.
UPDATE "lead" SET "property_id" = l."property_id"
  FROM "listing" l WHERE l."id" = "lead"."listing_id";--> statement-breakpoint
ALTER TABLE "lead" ALTER COLUMN "property_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "lead" ALTER COLUMN "listing_id" DROP NOT NULL;--> statement-breakpoint
-- restrict, matching listing.property_id: a property outlives every ad written
-- against it (#1), and so does a third party's offer on it. agency_id stays
-- cascade — that is a decision about an agency's own data.
ALTER TABLE "lead" ADD CONSTRAINT "lead_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_agency_created_idx" ON "lead" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "lead_property_idx" ON "lead" USING btree ("property_id");--> statement-breakpoint
-- Postgres does not index a foreign key column. Every "what happened at this
-- address" read filters on this one — the public timeline on each listing page,
-- and both halves of the off-market gate — and each was a full table scan.
CREATE INDEX "listing_property_idx" ON "listing" USING btree ("property_id");
