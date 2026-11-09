-- ADR 0087: an agent's own Twilio beside the agency's. Additive and idempotent.
-- `phone_account.owner_user_id` null = the agency's account (one per agency), set = that member's own
-- (one per member per agency). `phone_number.account_id` = the account a number lives on, backfilled to
-- the agency's account for every number that exists today. `phone_number.number_sid` is unique among
-- active numbers only: an agent's own number comes back as a new row in a new agency, and the old row
-- keeps the old agency's history.
-- Order: the code deployed before ADR 0087 upserts ON CONFLICT (agency_id), which only the old constraint
-- satisfies, so its "Connect" fails between this migration and the new code. Accepted in one step because
-- no real Twilio key had been connected (the stub never runs in production); deploy the code right after.
ALTER TABLE "phone_account" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN IF NOT EXISTS "account_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_account" ADD CONSTRAINT "phone_account_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_account_id_phone_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."phone_account"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_account_agency_idx" ON "phone_account" USING btree ("agency_id") WHERE owner_user_id is null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_account_owner_idx" ON "phone_account" USING btree ("agency_id","owner_user_id") WHERE owner_user_id is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_number_sid_active_idx" ON "phone_number" USING btree ("number_sid") WHERE status = 'active';
--> statement-breakpoint
ALTER TABLE "phone_account" DROP CONSTRAINT IF EXISTS "phone_account_agency_id_unique";
--> statement-breakpoint
ALTER TABLE "phone_number" DROP CONSTRAINT IF EXISTS "phone_number_number_sid_unique";
--> statement-breakpoint
UPDATE "phone_number" n SET "account_id" = a."id"
FROM "phone_account" a
WHERE n."account_id" IS NULL AND n."status" = 'active' AND a."agency_id" = n."agency_id" AND a."owner_user_id" IS NULL;
