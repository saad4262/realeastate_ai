# 0052 — Admin dashboard: who is online, email from the platform, blocking a site user

**Status:** ACCEPTED, 2026-10-21 (the user: a dashboard with how many agencies, agents and users, who is online, recent
members; email an agency, agent or user; block/suspend users, agents and agencies. Chosen: online = seen in the last
5 minutes; email one person or a whole audience; blocking a user = no sign-in on the site).

## Decision

1. **Online** — `user.last_seen_at` (migration 0060). The console's live poll (`/api/live`, every few seconds while a
   console page is open) and a once-a-minute `PresencePing` on the public site (signed-in visitors only, through
   `/api/activity`) call `touchLastSeen`, which writes at most once a minute. Online = seen in the last 5 minutes.
   Platform admins are not counted. An agency is online when one of its active members is.
2. **Dashboard** (`/platform`) — agencies / agents / users with online, suspended and blocked counts; who is online now;
   newest agencies, members and users with last seen; a link to write to everyone.
3. **Email from the platform** (`/emails`, and "Email the agency" / "Send email" on agency, member and user pages):
   audiences `agency` (its active owners and admins), `member`, `user`, `all_agencies`, `all_agents`, `all_users`.
   Recipients are resolved on the server (`recipientsSql`, one per address) and frozen in `platform_email_recipient`
   with the `platform_email` row; "Check recipients" shows the count first. The console sends the first 25 at once, the
   minute cron the rest (`deliverPlatformEmails`, claim → send outside any transaction → record; a stale claim is
   retried; idempotency key per recipient). Sender: the platform's alert sender; greeting + footer with the postal
   address. **Service messages only**, sent as transactional with no unsubscribe link — the compose screen says a
   promotion needs consent and an unsubscribe (Spam Act) and must not be sent from here.
4. **Blocking a site user** — `user.blocked_at` / `blocked_reason`; `blockSiteUser` / `unblockSiteUser`
   (`platform:manage`, recorded in `platform_action` with no agency). Enforced by: a Supabase ban (sign-in and token
   refresh refused; `AuthBan` port, service-role key, run after the transaction — a failed ban leaves the block and
   says so); `currentWebUser` treating a blocked id as signed out (one indexed read per signed-in request, fails open);
   the alert scheduler not claiming their saved searches. An agency member is refused here — they are blocked through
   their membership (ADR 0050). Agencies are suspended as before.

Migration 0060: three `user` columns, `platform_email`, `platform_email_recipient` (RLS on, no grants). It must be
applied BEFORE this code deploys: the new `user` columns are read by code that selects the whole row.
