-- Hand-written (2026-10-10): skills may run every 10 minutes, as saved searches
-- may. The floor was 60 when skills could only be scheduled in whole hours; the
-- form and the Markdown now take minutes, with the same 10-minute floor as
-- search_schedule (MIN_INTERVAL_MINUTES), because both are claimed by the same
-- 5-minute tick and catch up one slot per tick. Only widens: every existing
-- row (>= 60) stays allowed. Not in the drizzle snapshot, like 0037's CHECK.
ALTER TABLE "agent_skill" DROP CONSTRAINT "agent_skill_interval_ok";--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_interval_ok" CHECK (interval_minutes IS NULL OR interval_minutes >= 10);
