# 0057 — The sidebar in groups

**Status:** accepted, 2026-10-27 (the user, ROADMAP Phase 1.1). Replaces ADR 0045's "four primary
items, the rest behind More".

**Context.** The agency nav had 4 items up front and 14 behind More in no order. The brief's roadmap
adds 10–15 pages (Transactions, Control Centre, SMS, Ads…), so each needs a known place. While moving
them: agency "Insights" pointed at `/site-activity`, an admin path the agency host sends home
(middleware `isAdminPath`), and the agent's "Offers" was a `#` link to nothing.

**Decision.**
1. `surfaces.ts` describes the nav as `groups: NavGroup[]` (`label?`, `items`), not `primary` + `more`.
   The groups follow the brief's architecture: Daily work · People · Properties · Marketing ·
   Automation · Knowledge & insights · Money · Settings. A group without a label is always shown,
   with no heading (the agency's Overview + LocalAgent AI at the top; the admin's whole nav).
2. Each labelled group has a heading that collapses it. Daily work, and the group holding the page
   you are on, start open; arriving on a page inside a closed group opens it (as More did). A closed
   group with something unread inside shows the dot that More showed. The open state lives in the
   nav's own state, which survives client navigation because layouts are kept. It is not stored.
3. The agent sidebar uses the same groups, holding only its own pages. A group with nothing in it
   is not drawn. A page is listed only when it exists: Offers is gone (offers live in Leads), and
   pages still to be built are added to their group when they land.
4. Insights → `/insights`. Projects (the dashboards, AU9) sits in Knowledge & insights.

**Not done.** Remembering collapsed groups across reloads; reordering groups per agency; the
search box in the sidebar (still a placeholder).
