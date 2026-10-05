CREATE TYPE "public"."mail_channel" AS ENUM('console', 'email');--> statement-breakpoint
CREATE TYPE "public"."mail_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."mail_status" AS ENUM('received', 'queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "mail_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"direction" "mail_direction" NOT NULL,
	"channel" "mail_channel",
	"status" "mail_status" NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text,
	"to_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"html" text,
	"sent_by" uuid,
	"provider_id" text,
	"rfc_message_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_message_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "mail_read" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_read_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mail_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"lead_id" uuid,
	"subject" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_name" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_thread_lead_id_unique" UNIQUE("lead_id")
);
--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_thread_id_mail_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_sent_by_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_read" ADD CONSTRAINT "mail_read_thread_id_mail_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_read" ADD CONSTRAINT "mail_read_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_thread" ADD CONSTRAINT "mail_thread_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_thread" ADD CONSTRAINT "mail_thread_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_message_thread_idx" ON "mail_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_thread_agency_idx" ON "mail_thread" USING btree ("agency_id","last_message_at" desc);--> statement-breakpoint
CREATE INDEX "mail_thread_contact_idx" ON "mail_thread" USING btree ("contact_email");--> statement-breakpoint

--
-- Hand-written below. drizzle-kit does not model functions, triggers or
-- policies; do not lose this on the next `generate`. Same arrangement as
-- 0001, 0002, 0006, 0009 and 0012. See docs/adr/0016.
--

-- The subject a lead's conversation opens with. One expression, used by the
-- trigger and the backfill, so the two can never word it differently.
CREATE OR REPLACE FUNCTION public.mail_thread_subject(k lead_kind, p_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT (CASE k
            WHEN 'offer' THEN 'Private offer: '
            WHEN 'inspection' THEN 'Inspection request: '
            WHEN 'appraisal' THEN 'Appraisal request: '
            ELSE 'Enquiry about '
          END)
         || coalesce(
              nullif(p.formatted_address, ''),
              concat_ws(', ', nullif(concat_ws(' ', p.street_number, p.street), ''), p.suburb)
            )
  FROM property p WHERE p.id = p_id
$$;--> statement-breakpoint

-- Every lead gets its conversation in the same transaction that wrote it.
-- A trigger rather than a line in createEnquiry/createPrivateOffer: those two
-- write paths are not touched, and a lead written by the seed or a script is
-- covered too. ON CONFLICT makes a replayed insert harmless.
CREATE OR REPLACE FUNCTION public.mail_thread_for_lead()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO mail_thread
    (agency_id, lead_id, subject, contact_email, contact_name, last_message_at, last_inbound_at)
  VALUES
    (NEW.agency_id, NEW.id,
     coalesce(public.mail_thread_subject(NEW.kind, NEW.property_id), 'Enquiry'),
     lower(trim(NEW.email)), NEW.name, NEW.created_at, NEW.created_at)
  ON CONFLICT (lead_id) DO NOTHING;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER lead_mail_thread
  AFTER INSERT ON lead
  FOR EACH ROW EXECUTE FUNCTION public.mail_thread_for_lead();--> statement-breakpoint

-- Every lead that already exists, once.
INSERT INTO mail_thread
  (agency_id, lead_id, subject, contact_email, contact_name, last_message_at, last_inbound_at)
SELECT l.agency_id, l.id,
       coalesce(public.mail_thread_subject(l.kind, l.property_id), 'Enquiry'),
       lower(trim(l.email)), l.name, l.created_at, l.created_at
FROM lead l
ON CONFLICT (lead_id) DO NOTHING;--> statement-breakpoint

-- Defence in depth, the same line `lead_select_member` draws. The server
-- connects as the owner and decides per thread with can(); these stop a
-- client holding a Supabase key from reading another agency's mail.
-- No INSERT/UPDATE/DELETE policy: only the server writes mail.
ALTER TABLE "mail_thread" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail_read" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY mail_thread_select_member ON mail_thread
  FOR SELECT USING (agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY mail_message_select_member ON mail_message
  FOR SELECT USING (agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY mail_read_select_own ON mail_read
  FOR SELECT USING (user_id = auth.uid());
