ALTER TABLE "email_template" ADD COLUMN "agency_wide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Hand-written tail (ADR 0043). Templates already approved were approved FOR the agency.
UPDATE "email_template" SET "agency_wide" = true WHERE "status" = 'approved';--> statement-breakpoint
-- No approval step any more: a draft or a template waiting for approval is ready now, by its author —
-- for the whole agency if its author is an owner/admin of it today, otherwise for its author only.
UPDATE "email_template" t SET
  "status" = 'approved',
  "approved_by" = t."created_by",
  "approved_at" = now(),
  "agency_wide" = EXISTS (
    SELECT 1 FROM "membership" m
    WHERE m."user_id" = t."created_by" AND m."agency_id" = t."agency_id" AND m."status" = 'active' AND m."role" IN ('owner', 'admin')
  ),
  "updated_at" = now()
WHERE t."status" IN ('draft', 'pending_approval');
