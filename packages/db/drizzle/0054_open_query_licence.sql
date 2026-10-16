-- ADR 0044 B: the agents dataset carries each person's licence (number, class, expiry). The view
-- keeps every column it had, in the same order, and appends the three (CREATE OR REPLACE VIEW may
-- only add columns at the end). Still security_barrier, still only the ticket's agency (L4).
CREATE OR REPLACE VIEW ai.agent_profile WITH (security_barrier) AS
  SELECT p.user_id, p.display_name, p.territory_suburbs, p.territory_radius_km, p.specialties, p.languages,
         p.years_experience, p.commission_tier, p.commission_split_agent, p.commission_split_agency,
         p.licence_number, p.licence_class, p.licence_expiry
  FROM public.agent_profile p
  WHERE p.user_id IN (SELECT m.user_id FROM public.membership m WHERE m.agency_id = ai.ticket_agency());--> statement-breakpoint
GRANT SELECT ON ai.agent_profile TO ai_reader;
