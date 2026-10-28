-- ADR 0066 + 0067: seven more workflow triggers (widens the CHECK; every existing row still passes) and what the AI chose at the start of a run. Additive.
ALTER TABLE "workflow_run" ADD COLUMN "decision" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_event" DROP CONSTRAINT "workflow_event_kind_check";--> statement-breakpoint
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_kind_check" CHECK (kind IN ('lead.created', 'lead.status_changed', 'lead.no_reply', 'appointment.booked', 'listing.status_changed', 'contact.created', 'deal.stage_reached', 'deal.settled', 'buyer.matched', 'appointment.upcoming', 'appointment.completed', 'appraisal.not_listed', 'sale.anniversary'));
