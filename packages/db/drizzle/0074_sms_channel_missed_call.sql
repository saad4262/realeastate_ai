-- ADR 0074 (ROADMAP 3.4, the parts that do not wait on the client's five SMS rules): a template's channel
-- (email or sms) and the workflow trigger "a call is missed". Additive and idempotent: every existing
-- template is an email template, every existing event row still passes the wider CHECK.
ALTER TABLE "email_template" ADD COLUMN IF NOT EXISTS "channel" varchar(8) DEFAULT 'email' NOT NULL;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "email_template" ADD CONSTRAINT "email_template_channel_check" CHECK (channel IN ('email', 'sms')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "workflow_event" DROP CONSTRAINT IF EXISTS "workflow_event_kind_check";--> statement-breakpoint
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_kind_check" CHECK (kind IN ('lead.created', 'lead.status_changed', 'lead.no_reply', 'appointment.booked', 'listing.status_changed', 'contact.created', 'deal.stage_reached', 'deal.settled', 'buyer.matched', 'appointment.upcoming', 'appointment.completed', 'appraisal.not_listed', 'sale.anniversary', 'call.missed'));
