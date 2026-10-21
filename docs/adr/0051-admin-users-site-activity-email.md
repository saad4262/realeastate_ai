# 0051 — Admin console: Users, site activity, email activity, and its home

**Status:** ACCEPTED, 2026-10-21 (the user: agencies, agents and users as three sections; email sends and replies
per agency/agent; users' search activity — which suburbs, which agencies' listings; and a proper design. Chosen:
signed-in visitors tracked by account, anonymous visitors counted only).

## Decision

1. **Site activity is recorded from now on** (`site_activity`, migration 0059): a search (place, channel, and —
   signed in only — the filters) or a listing view (the listing, and its suburb and agency read from the
   listing). Nothing was recorded before, so there is no history.
   - `/search` and `/listing/[id]` keep no session (apps/web/middleware.ts, the 33 ms pages). They render an
     `ActivityBeacon` that POSTs to `/api/activity` after render; that route is in the matcher, so the verified
     session (or none) says WHO. The body says only WHAT; it is validated (`siteActivityInputSchema`) and the
     agency never comes from it. Rate-limited per IP, bots by user agent skipped, always 204.
   - Only a public listing (live, agency not suspended) records a view. Page 1 of a search counts; paging does not.
   - Privacy policy says so (apps/web privacy page, "If you use the public website") — **for the owner to review**.
2. **Users section** (`/users`, `/users/[id]`): accounts with no agency membership and not platform admins —
   searches, listings opened, enquiries (and to which agency), shortlist, saved searches and alerts, and their
   property-guide conversations (readable, `?c=`), plus where they look and which agencies they favour.
   **Site activity** (`/site-activity`): top suburbs, agencies and listings over 7/30/90 days.
3. **Email activity** tab for an agency and a member: sent / failed / queued / received / replies / via Gmail, by
   kind, by member, bulk batches, latest messages. Delivery, opens and bounces are not recorded anywhere, so not shown.
4. **Home**: needs-attention (trials ending ≤ 14 days, suspended agencies, failed email in 24 h, blocked members),
   leads per week (12 weeks), where visitors look, agencies drawing interest. Profile headers; the admin shell
   collapses to a top bar under 900 px.

All reads `platform:read` (email activity under a `platform` view), fixed statement counts, unit-tested; every page
logs to `platform_view_log` (a user's pages with `subject_user_id`).
