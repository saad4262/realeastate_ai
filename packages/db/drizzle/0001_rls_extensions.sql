CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE agency ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE office ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE team ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE listing ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE listing_agent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE property ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE media ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inspection ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE lead ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.user_agency_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT agency_id FROM membership WHERE user_id = auth.uid() AND status = 'active'; $$;--> statement-breakpoint
CREATE POLICY user_self_select ON "user" FOR SELECT USING (id = auth.uid());--> statement-breakpoint
CREATE POLICY membership_select_own ON membership FOR SELECT USING (user_id = auth.uid() OR agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY agency_select_member ON agency FOR SELECT USING (id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY office_select_member ON office FOR SELECT USING (agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY team_select_member ON team FOR SELECT USING (agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY listing_select_member ON listing FOR SELECT USING (agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY listing_update_member ON listing FOR UPDATE USING (agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY listing_agent_select ON listing_agent FOR SELECT USING (listing_id IN (SELECT id FROM listing WHERE agency_id IN (SELECT public.user_agency_ids())));--> statement-breakpoint
CREATE POLICY property_select_via_listing ON property FOR SELECT USING (id IN (SELECT property_id FROM listing WHERE agency_id IN (SELECT public.user_agency_ids())));--> statement-breakpoint
CREATE POLICY media_select_member ON media FOR SELECT USING (listing_id IN (SELECT id FROM listing WHERE agency_id IN (SELECT public.user_agency_ids())));--> statement-breakpoint
CREATE POLICY inspection_select_member ON inspection FOR SELECT USING (listing_id IN (SELECT id FROM listing WHERE agency_id IN (SELECT public.user_agency_ids())));--> statement-breakpoint
CREATE POLICY lead_select_member ON lead FOR SELECT USING (agency_id IN (SELECT public.user_agency_ids()));--> statement-breakpoint
CREATE POLICY agent_profile_select ON agent_profile FOR SELECT USING (true);
