-- V1-PERFORMANCE-PLAN step 7: Listing activity counts searches in the places where an agency's listings are live. With
-- only (created_at) to go on, every agency's page read the whole platform's activity for the period. On production,
-- build it first with db:concurrent-indexes (site_activity grows with every page view).
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_activity_search_suburb_idx" ON "site_activity" USING btree (lower("suburb"),"created_at") WHERE "site_activity"."kind" = 'search';
