-- ADR 0025 amendment (2026-10-09): more assistant tools, and a contact that can be deleted.
-- Generated (columns, FK, index) + hand-written below (the tool CHECK and the trigger).
-- Additive: two nullable columns on contact, one on email_template, one partial index.
-- No existing row changes. Numbered 0039 and dated after 0038 (lead_handover).
ALTER TABLE "contact" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "email_template" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_deleted_idx" ON "contact" USING btree ("agency_id","deleted_at") WHERE deleted_at is not null;--> statement-breakpoint
-- The closed list of assistant tools that may be proposed: every tool allowed
-- today plus the six new ones (assign_leads, send_new_template_email,
-- save_email_template, delete_contact, restore_contact, import_listings).
-- No row changes: every existing value stays allowed.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'assign_leads', 'send_new_template_email', 'save_email_template', 'delete_contact', 'restore_contact', 'import_listings'));--> statement-breakpoint
-- 0020's lead trigger, plus one thing: a new enquiry (or offer) that lands on a
-- contact deleted less than 7 days ago brings it back, with a timeline line —
-- otherwise the purge would later cut the new lead off from its person.
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
  UPDATE contact SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
   WHERE id = NEW.contact_id AND deleted_at IS NOT NULL;
  IF FOUND THEN
    INSERT INTO activity (agency_id, contact_id, kind, actor_type, payload)
    VALUES (NEW.agency_id, NEW.contact_id, 'contact_undeleted', 'system', jsonb_build_object('via', 'enquiry'));
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
REVOKE EXECUTE ON FUNCTION public.lead_contact() FROM PUBLIC, anon, authenticated;
