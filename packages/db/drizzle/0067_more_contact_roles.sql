-- ADR 0061: three more contact roles (prospect, past client, referral partner). Additive: existing rows keep theirs.
ALTER TYPE "public"."contact_role_kind" ADD VALUE 'prospect';--> statement-breakpoint
ALTER TYPE "public"."contact_role_kind" ADD VALUE 'past_client';--> statement-breakpoint
ALTER TYPE "public"."contact_role_kind" ADD VALUE 'referral_partner';