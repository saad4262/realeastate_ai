-- ADR 0081: open-home entry, the write side of `inspection` (empty until now; only a smoke test ever wrote to it).
-- Additive and idempotent: who entered a time, and one index that is both the read of a listing's times and the rule
-- that the same start cannot be saved twice. The deployed code selects named columns, so it is unaffected.
ALTER TABLE "inspection" ADD COLUMN IF NOT EXISTS "created_by" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inspection_listing_starts_idx" ON "inspection" USING btree ("listing_id","starts_at");
