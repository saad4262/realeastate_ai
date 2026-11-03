-- ADR 0080, C2 decision 4: record a public listing's price changes from now on. Additive and idempotent: a new
-- table and a trigger; nothing is backfilled (there is no history to backfill — only the current price was kept).
CREATE TABLE IF NOT EXISTS "listing_price_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"old_display" text,
	"old_from" numeric(14, 2),
	"old_to" numeric(14, 2),
	"new_display" text,
	"new_from" numeric(14, 2),
	"new_to" numeric(14, 2),
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "listing_price_change" ADD CONSTRAINT "listing_price_change_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "listing_price_change" ADD CONSTRAINT "listing_price_change_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_price_change_listing_idx" ON "listing_price_change" USING btree ("listing_id","changed_at");--> statement-breakpoint
-- Hand-written tail. One trigger catches every path that edits a price (the form, an import, the assistant) —
-- a write path added later cannot forget it. Only once the listing has been public: a draft's edits are not
-- history a buyer should read. IS DISTINCT FROM, so null → a price and a price → null both count.
CREATE OR REPLACE FUNCTION public.listing_price_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND (
    OLD.price_display IS DISTINCT FROM NEW.price_display
    OR OLD.price_from IS DISTINCT FROM NEW.price_from
    OR OLD.price_to IS DISTINCT FROM NEW.price_to
  ) THEN
    INSERT INTO listing_price_change (listing_id, agency_id, old_display, old_from, old_to, new_display, new_from, new_to)
    VALUES (NEW.id, NEW.agency_id, OLD.price_display, OLD.price_from, OLD.price_to, NEW.price_display, NEW.price_from, NEW.price_to);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.listing_price_change() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
DROP TRIGGER IF EXISTS listing_price_change ON listing;--> statement-breakpoint
CREATE TRIGGER listing_price_change
  AFTER UPDATE OF price_display, price_from, price_to ON listing
  FOR EACH ROW EXECUTE FUNCTION public.listing_price_change();--> statement-breakpoint
-- Server only (ADR 0017): RLS on, no grants, no policy.
ALTER TABLE "listing_price_change" ENABLE ROW LEVEL SECURITY;
