-- ADR 0090: a Twilio account is either one the agency or agent connected (byo) or a subaccount the
-- platform made under its own Twilio (managed). Additive and idempotent: every row today is byo, which
-- is the default, so nothing is backfilled and the code deployed before this keeps working.
-- A managed account's subaccount SID is `account_sid` (no second column that could disagree with it).
-- A member's own account (owner_user_id set, ADR 0087) is always byo: the platform never makes one.
-- `phone_number.previous_webhooks`: how Twilio routed a number we found on a byo account, kept so it
-- can be put back when the number stops being used here.
ALTER TABLE "phone_account" ADD COLUMN IF NOT EXISTS "kind" varchar(8) DEFAULT 'byo' NOT NULL;
--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN IF NOT EXISTS "previous_webhooks" jsonb;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_account" ADD CONSTRAINT "phone_account_kind_check" CHECK (kind IN ('byo', 'managed'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_account" ADD CONSTRAINT "phone_account_managed_is_agency_check" CHECK (kind = 'byo' OR owner_user_id IS NULL);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
