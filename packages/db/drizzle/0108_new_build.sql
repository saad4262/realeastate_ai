-- ADR 0099: the agent's "New home, house-and-land or off the plan" tick; the public Build tab searches it.
-- Additive with a constant default: no table rewrite, and the lock is held only to change the catalogue.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "is_new_build" boolean DEFAULT false NOT NULL;
