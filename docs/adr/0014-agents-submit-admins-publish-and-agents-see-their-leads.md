# 0014 — Agents submit, admins publish; agents see only their own leads

**Status:** accepted, 2026-10-02. Amends the `listing:publish` rule in permissions.ts
and the agent half of `lead:read`.

**Context.** The client wants an approval step: an agent named on a listing could
publish it straight to the public site, with nobody at the agency seeing it first.
Separately, `lead:read` let any active member read every non-offer lead in the
agency; that was harmless while the agent desk had no Leads screen, and wrong the
moment it gets one.

**Decision.**
1. `pending` (already in `listing_status`, never written) means "submitted for
   approval". New action `listing:submit` — admin or listing agent — moves a draft
   or withdrawn listing to `pending`. `listing:publish` (anything → `live`) is now
   owner/admin only. Leaving `pending` back to `draft` (cancel / send back) is an
   edit. Selling, under offer and withdrawing keep their rules: none of them puts
   new content in front of the public. Consequence: a deal that falls through under
   offer needs an admin to put the ad back live.
2. A lead is visible to an admin, to the member it is assigned to, and to an agent
   named on the listing it came through — assigned or not. Offers stay owner/admin
   only. Inbox-wide reads (`lead:read_all`, admins) decide in SQL whether to scope;
   a single lead's visibility is `lead:read` with the lead's assignee and listing on
   the resource. The agent desk gets `/my-leads` over the same core read.

**Not done.** An agent editing a LIVE listing still changes the public ad without
review; approving edits needs revisions, which is a separate piece of work.
