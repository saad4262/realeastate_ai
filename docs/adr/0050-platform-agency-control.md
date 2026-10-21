# 0050 — Platform admin controls: suspend an agency, plan and trial, block a member, change the owner

**Status:** ACCEPTED, 2026-10-21 (the user chose "1. Agency control" from the list of what the admin console
could do next). Extends ADR 0049, which made the console read-only; this adds its first writes.

## Decision

1. **`platform:manage`** — the platform admin themself (never a `platform` view). Every admin has it; no admin
   roles yet. Core: `suspendAgency`, `reactivateAgency`, `setAgencyPlan`, `blockMember`, `unblockMember`,
   `makeOwner` (`packages/core/src/platform/manage.ts`). Each writes a `platform_action` row (admin, agency,
   member, kind, detail with the reason or before/after) in the same transaction.
2. **Suspend an agency** (`agency.status = 'suspended'`, with `suspended_at` / `suspended_reason`). Enforced
   where people and work come in, not by the action:
   - console — `accessBlock` in the actor loader: an active member of a suspended agency gets an actor with no
     agency (every can() refuses) and the sign-in page says why; /get-started does not offer a new agency;
   - public site — `publicListing()` (live AND agency not suspended) in search, the listing page, facets,
     sidebar, suburbs/types, nearby market, place suggestions, reviews, the property→listing redirect and
     enquiries; the console asks the web app to drop its listing cache. Sold history stays (a property's record);
   - background work — `SUSPENDED_AGENCY_IDS` in the claim queries of workflows (the event is spent), skills,
     scheduled steps, imports and bulk email (these wait and resume on reactivation).
   Reactivate as active or trial. Nothing is deleted either way.
3. **Block a member** (`membership.status = 'suspended'` WITHOUT `removed_at`; a removal by the agency, ADR 0030,
   has it). Out of the console (`member_blocked`), may not register an agency of their own, their bulk email
   waits. Not the agency's last active owner. Unblock refused if they became active elsewhere since.
   Known: their workflows pause (the engine's "owner no longer active") and stay paused after an unblock.
4. **Plan and trial** — `agency.plan` (free text, suggested trial/starter/pro/enterprise), active or trial,
   `trial_ends_at`. Recorded and shown only; nothing switches off when a trial ends yet.
5. **Owner** — make an active member owner; by default the other owners become admins.

Migration 0058: three `agency` columns, `platform_action` (RLS on, no grants).
