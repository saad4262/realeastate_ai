-- 0002 was hand-written without a snapshot, so drizzle-kit re-emitted its statements.
-- Only the genuinely new constraints are kept here; the 0003 snapshot is correct.
CREATE UNIQUE INDEX IF NOT EXISTS "membership_user_agency_idx"
  ON "membership" USING btree ("user_id", "agency_id");
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "user" ADD CONSTRAINT "user_email_unique" UNIQUE ("email");
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;
