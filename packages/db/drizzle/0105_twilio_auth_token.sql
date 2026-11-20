-- PLATFORM-PLAN 3.10, ADR 0096: a managed Twilio subaccount's Auth Token (and its secondary during a rotation), encrypted.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
ALTER TABLE "phone_account" ADD COLUMN "auth_token" text;--> statement-breakpoint
ALTER TABLE "phone_account" ADD COLUMN "auth_token_next" text;
