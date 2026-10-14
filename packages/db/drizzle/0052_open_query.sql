CREATE TABLE "ai_query_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid,
	"via" varchar(16) NOT NULL,
	"sql" text NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"detail" text,
	"ms" integer,
	"rows" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_query_ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_query_log" ADD CONSTRAINT "ai_query_log_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_query_log" ADD CONSTRAINT "ai_query_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_query_ticket" ADD CONSTRAINT "ai_query_ticket_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_query_ticket" ADD CONSTRAINT "ai_query_ticket_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_query_log_agency_idx" ON "ai_query_log" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
-- Hand-written tail (ADR 0042, L3 and L4). Server-only tables (ADR 0017): RLS on, no policy, no grant.
ALTER TABLE "ai_query_ticket" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_query_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_query_log" ADD CONSTRAINT "ai_query_log_via_check" CHECK (via IN ('assistant', 'tile'));--> statement-breakpoint
ALTER TABLE "ai_query_log" ADD CONSTRAINT "ai_query_log_outcome_check" CHECK (outcome IN ('ok', 'rejected', 'error', 'too_slow', 'capped'));--> statement-breakpoint

-- L3: the role an open query runs as. No login; only `SET LOCAL ROLE` from the server's own
-- connection inside the query's transaction. It is given the `ai` schema's views and nothing else.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_reader') THEN
    CREATE ROLE ai_reader NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;--> statement-breakpoint
-- Postgres 16+: a role made with CREATEROLE is not settable by its maker until granted WITH SET.
GRANT ai_reader TO postgres WITH INHERIT FALSE, SET TRUE;--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS ai;--> statement-breakpoint
REVOKE ALL ON SCHEMA ai FROM PUBLIC;--> statement-breakpoint

-- L4: the agency of THIS transaction's ticket, or null (nothing matches null). The ticket row is
-- inserted inside the query's own transaction and never committed, so the only ticket any query
-- can name is its own. SECURITY DEFINER: `ai_reader` may call it but may not read the table.
CREATE OR REPLACE FUNCTION ai.ticket_agency() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.agency_id FROM public.ai_query_ticket t
  WHERE t.id = CASE WHEN current_setting('ai.ticket', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN current_setting('ai.ticket', true)::uuid END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ai.ticket_agency() FROM PUBLIC;--> statement-breakpoint

-- The views: the same names as the tables, so core's scope helpers (which name `lead`,
-- `listing_agent` …) run unchanged with `search_path = ai`. Only the columns figures need — no
-- tokens, provider ids, meeting links, html or attachments. security_barrier, so no predicate the
-- query adds runs before the agency filter.
CREATE VIEW ai."user" WITH (security_barrier) AS
  SELECT u.id, u.name, u.email, u.phone FROM public."user" u
  WHERE u.id IN (SELECT m.user_id FROM public.membership m WHERE m.agency_id = ai.ticket_agency());--> statement-breakpoint
CREATE VIEW ai.membership WITH (security_barrier) AS
  SELECT id, user_id, agency_id, office_id, role, status, joined_at, removed_at FROM public.membership
  WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.agent_profile WITH (security_barrier) AS
  SELECT p.user_id, p.display_name, p.territory_suburbs, p.territory_radius_km, p.specialties, p.languages,
         p.years_experience, p.commission_tier, p.commission_split_agent, p.commission_split_agency
  FROM public.agent_profile p
  WHERE p.user_id IN (SELECT m.user_id FROM public.membership m WHERE m.agency_id = ai.ticket_agency());--> statement-breakpoint
CREATE VIEW ai.office WITH (security_barrier) AS
  SELECT id, agency_id, name FROM public.office WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.listing WITH (security_barrier) AS
  SELECT id, property_id, agency_id, office_id, team_id, channel, status, price_from, price_to, price_display, rent_pw,
         headline, sold_price, sold_date, published_at, auction_date, expires_at, source, created_at, updated_at
  FROM public.listing WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.listing_agent WITH (security_barrier) AS
  SELECT la.listing_id, la.user_id, la.role, la.display_order, la.created_at FROM public.listing_agent la
  WHERE la.listing_id IN (SELECT l.id FROM public.listing l WHERE l.agency_id = ai.ticket_agency());--> statement-breakpoint
CREATE VIEW ai.property WITH (security_barrier) AS
  SELECT p.id, p.unit, p.street_number, p.street, p.suburb, p.state, p.postcode, p.property_type, p.bedrooms,
         p.bathrooms, p.car_spaces, p.land_area_sqm, p.building_area_sqm, p.year_built
  FROM public.property p
  WHERE EXISTS (SELECT 1 FROM public.listing l WHERE l.property_id = p.id AND l.agency_id = ai.ticket_agency())
     OR EXISTS (SELECT 1 FROM public.lead l WHERE l.property_id = p.id AND l.agency_id = ai.ticket_agency())
     OR EXISTS (SELECT 1 FROM public.appointment a WHERE a.property_id = p.id AND a.agency_id = ai.ticket_agency())
     OR EXISTS (SELECT 1 FROM public.contact_property cp JOIN public.contact c ON c.id = cp.contact_id
                WHERE cp.property_id = p.id AND c.agency_id = ai.ticket_agency());--> statement-breakpoint
CREATE VIEW ai.lead WITH (security_barrier) AS
  SELECT id, property_id, listing_id, agency_id, name, email, phone, message, kind, status, source, offer_amount,
         assigned_to, contact_id, created_at, updated_at
  FROM public.lead WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.contact WITH (security_barrier) AS
  SELECT id, agency_id, name, email, phone, assigned_to, source, next_action, next_action_at, marketing_consent_at,
         email_opt_out_at, archived_at, merged_into_id, created_at, updated_at
  FROM public.contact WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.contact_role WITH (security_barrier) AS
  SELECT r.contact_id, r.role, r.created_at FROM public.contact_role r
  WHERE r.contact_id IN (SELECT c.id FROM public.contact c WHERE c.agency_id = ai.ticket_agency());--> statement-breakpoint
CREATE VIEW ai.contact_property WITH (security_barrier) AS
  SELECT cp.contact_id, cp.property_id, cp.relation, cp.created_at FROM public.contact_property cp
  WHERE cp.contact_id IN (SELECT c.id FROM public.contact c WHERE c.agency_id = ai.ticket_agency());--> statement-breakpoint
CREATE VIEW ai.mail_thread WITH (security_barrier) AS
  SELECT id, agency_id, lead_id, subject, contact_email, contact_name, contact_id, last_message_at, last_inbound_at, created_at
  FROM public.mail_thread WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.mail_message WITH (security_barrier) AS
  SELECT id, thread_id, agency_id, direction, channel, status, from_email, from_name, to_emails, subject, text,
         sent_by, kind, sent_via, created_at
  FROM public.mail_message WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.appointment WITH (security_barrier) AS
  SELECT id, agency_id, kind, contact_id, property_id, created_by, assigned_agent_id, title, type, status, starts_at,
         ends_at, timezone, location, outcome, created_at
  FROM public.appointment WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.appointment_participant WITH (security_barrier) AS
  SELECT appointment_id, user_id, agency_id, declined_at FROM public.appointment_participant
  WHERE agency_id = ai.ticket_agency();--> statement-breakpoint
CREATE VIEW ai.note WITH (security_barrier) AS
  SELECT id, agency_id, contact_id, author_id, body, is_private, deleted_at, created_at FROM public.note
  WHERE agency_id = ai.ticket_agency();--> statement-breakpoint

-- What `ai_reader` holds: the schema, SELECT on the views, the ticket function. Nothing in `public`.
GRANT USAGE ON SCHEMA ai TO ai_reader;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA ai TO ai_reader;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ai.ticket_agency() TO ai_reader;
