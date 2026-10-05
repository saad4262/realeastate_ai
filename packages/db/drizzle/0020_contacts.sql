-- Contacts (docs/adr/0018). The tables below are drizzle-kit's; everything
-- marked "Hand-written" is not modelled by drizzle-kit — do not lose it on the
-- next `generate`. Same arrangement as 0001, 0016.
--
-- Hand-written: the phone key, needed BEFORE `contact` because its generated
-- column calls it. Digits only; an Australian number in international form, so
-- "0412 345 678", "+61 412 345 678" and "+61 (0)412 345 678" are one key. Fewer
-- than 8 digits is not a phone number anybody could match on: null. The same
-- rule is `auPhoneKey` in packages/core/src/contacts/phone.ts, and the smoke
-- suite holds the two to the same answers.
CREATE OR REPLACE FUNCTION public.au_phone_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE
    WHEN length(d) < 8 THEN NULL
    WHEN d LIKE '610%' AND length(d) = 12 THEN '61' || substr(d, 4)
    WHEN d LIKE '61%' AND length(d) = 11 THEN d
    WHEN d LIKE '0%' AND length(d) = 10 THEN '61' || substr(d, 2)
    WHEN length(d) = 9 AND d ~ '^[23478]' THEN '61' || d
    ELSE d
  END
  FROM (SELECT pg_catalog.regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) s
$$;--> statement-breakpoint
CREATE TYPE "public"."activity_actor_type" AS ENUM('user', 'system', 'skill', 'ai');--> statement-breakpoint
CREATE TYPE "public"."contact_property_relation" AS ENUM('owner', 'vendor', 'landlord', 'tenant', 'interested', 'other');--> statement-breakpoint
CREATE TYPE "public"."contact_role_kind" AS ENUM('seller', 'buyer', 'landlord', 'tenant', 'investor');--> statement-breakpoint
CREATE TYPE "public"."contact_source" AS ENUM('enquiry', 'offer', 'email', 'manual', 'import');--> statement-breakpoint
CREATE TYPE "public"."contact_tag_source" AS ENUM('manual', 'inferred');--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"actor_type" "activity_actor_type" DEFAULT 'user' NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"phone_key" text GENERATED ALWAYS AS (public.au_phone_key(phone)) STORED,
	"assigned_to" uuid,
	"user_id" uuid,
	"source" "contact_source" DEFAULT 'manual' NOT NULL,
	"next_action" text,
	"next_action_at" timestamp with time zone,
	"marketing_consent_at" timestamp with time zone,
	"marketing_consent_note" text,
	"marketing_consent_by" uuid,
	"email_opt_out_at" timestamp with time zone,
	"merged_into_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_property" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"relation" "contact_property_relation" NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_role" (
	"contact_id" uuid NOT NULL,
	"role" "contact_role_kind" NOT NULL,
	"source" "contact_tag_source" DEFAULT 'manual' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_role_contact_id_role_pk" PRIMARY KEY("contact_id","role")
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_thread" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_marketing_consent_by_user_id_fk" FOREIGN KEY ("marketing_consent_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_merged_into_id_contact_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_property" ADD CONSTRAINT "contact_property_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_property" ADD CONSTRAINT "contact_property_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_property" ADD CONSTRAINT "contact_property_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_role" ADD CONSTRAINT "contact_role_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_role" ADD CONSTRAINT "contact_role_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_contact_idx" ON "activity" USING btree ("contact_id","occurred_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "contact_agency_email_idx" ON "contact" USING btree ("agency_id","email") WHERE email is not null and merged_into_id is null;--> statement-breakpoint
CREATE INDEX "contact_agency_phone_key_idx" ON "contact" USING btree ("agency_id","phone_key");--> statement-breakpoint
CREATE INDEX "contact_agency_assigned_idx" ON "contact" USING btree ("agency_id","assigned_to");--> statement-breakpoint
CREATE INDEX "contact_agency_created_idx" ON "contact" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "contact_property_unique_idx" ON "contact_property" USING btree ("contact_id","property_id","relation");--> statement-breakpoint
CREATE INDEX "contact_property_property_idx" ON "contact_property" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "contact_role_role_idx" ON "contact_role" USING btree ("role","contact_id");--> statement-breakpoint
CREATE INDEX "note_contact_idx" ON "note" USING btree ("contact_id","created_at" desc);--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_thread" ADD CONSTRAINT "mail_thread_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_contact_idx" ON "lead" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "mail_thread_contact_id_idx" ON "mail_thread" USING btree ("contact_id");--> statement-breakpoint
--
-- Hand-written below.
--
-- The one place a person is found or made. Matched on the lower-cased email
-- within the agency. On a match it FILLS a blank phone and never overwrites
-- anything somebody typed — automatic capture must not silently change a
-- contact (the user's rule). The name is the first one we were given.
-- `user_id` is deliberately not set here: sign-up does not confirm an email in
-- this project (ADR 0016), so an account's address is not proof it is them.
CREATE OR REPLACE FUNCTION public.contact_upsert(
  p_agency uuid, p_email text, p_name text, p_phone text, p_source contact_source
) RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_email text := nullif(lower(trim(p_email)), '');
  v_name text := coalesce(nullif(trim(p_name), ''), v_email, 'Unknown');
  v_phone text := nullif(trim(p_phone), '');
  v_id uuid;
BEGIN
  IF v_email IS NULL THEN
    INSERT INTO contact (agency_id, name, phone, source)
    VALUES (p_agency, v_name, v_phone, p_source)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  INSERT INTO contact (agency_id, name, email, phone, source)
  VALUES (p_agency, v_name, v_email, v_phone, p_source)
  ON CONFLICT (agency_id, email) WHERE email IS NOT NULL AND merged_into_id IS NULL
  DO UPDATE SET
    phone = coalesce(contact.phone, excluded.phone),
    updated_at = CASE WHEN contact.phone IS NULL AND excluded.phone IS NOT NULL
                      THEN now() ELSE contact.updated_at END
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;--> statement-breakpoint
-- Every lead is somebody's. BEFORE INSERT, so the lead row is written with its
-- contact, and the thread trigger (AFTER INSERT, 0016) can copy it. Like that
-- trigger, neither createEnquiry nor createPrivateOffer had to change, and the
-- seed and scripts are covered. Also tags what the lead says they are — an
-- inferred role, which an agent can see is inferred and remove.
CREATE OR REPLACE FUNCTION public.lead_contact()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_channel listing_channel;
  v_role contact_role_kind;
BEGIN
  IF NEW.contact_id IS NULL THEN
    NEW.contact_id := public.contact_upsert(
      NEW.agency_id, NEW.email, NEW.name, NEW.phone,
      (CASE WHEN NEW.kind = 'offer' THEN 'offer' ELSE 'enquiry' END)::contact_source);
  ELSIF NOT EXISTS (SELECT 1 FROM contact c WHERE c.id = NEW.contact_id AND c.agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'lead.contact_id belongs to another agency' USING ERRCODE = '23503';
  END IF;
  IF NEW.listing_id IS NOT NULL THEN
    SELECT l.channel INTO v_channel FROM listing l WHERE l.id = NEW.listing_id;
  END IF;
  v_role := CASE
    WHEN NEW.kind = 'appraisal' THEN 'seller'
    WHEN v_channel IN ('rent', 'leased') THEN 'tenant'
    ELSE 'buyer'
  END;
  INSERT INTO contact_role (contact_id, role, source)
  VALUES (NEW.contact_id, v_role, 'inferred')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER lead_contact
  BEFORE INSERT ON lead
  FOR EACH ROW EXECUTE FUNCTION public.lead_contact();--> statement-breakpoint
-- 0016's thread trigger, now carrying the lead's contact.
CREATE OR REPLACE FUNCTION public.mail_thread_for_lead()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO mail_thread
    (agency_id, lead_id, contact_id, subject, contact_email, contact_name, last_message_at, last_inbound_at)
  VALUES
    (NEW.agency_id, NEW.id, NEW.contact_id,
     coalesce(public.mail_thread_subject(NEW.kind, NEW.property_id), 'Enquiry'),
     lower(trim(NEW.email)), NEW.name, NEW.created_at, NEW.created_at)
  ON CONFLICT (lead_id) DO NOTHING;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mail_thread_for_lead() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
-- Mail to the agency's own address (no lead): the sender becomes, or is
-- matched to, a contact — "Tom emails the agency, it is on Tom's profile".
-- Except when the sender is one of the agency's own active members: a
-- colleague is not a customer.
CREATE OR REPLACE FUNCTION public.mail_thread_contact()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.contact_id IS NULL AND NEW.lead_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM membership m JOIN "user" u ON u.id = m.user_id
    WHERE m.agency_id = NEW.agency_id AND m.status = 'active'
      AND lower(u.email) = lower(NEW.contact_email)
  ) THEN
    NEW.contact_id := public.contact_upsert(
      NEW.agency_id, NEW.contact_email, NEW.contact_name, NULL, 'email');
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER mail_thread_contact
  BEFORE INSERT ON mail_thread
  FOR EACH ROW EXECUTE FUNCTION public.mail_thread_contact();--> statement-breakpoint
-- Server-only, like everything since 0019 (ADR 0017): RLS on, no policies.
-- The default privileges from 0019 already keep these tables and functions
-- away from anon/authenticated; the REVOKEs say so where it can be read.
ALTER TABLE "contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_property" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.au_phone_key(text) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.contact_upsert(uuid, text, text, text, contact_source) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lead_contact() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mail_thread_contact() FROM PUBLIC, anon, authenticated;
