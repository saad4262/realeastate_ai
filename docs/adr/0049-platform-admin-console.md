# 0049 — The platform admin console: every agency, read-only, every read recorded

**Status:** ACCEPTED, 2026-10-20 (the user, Roman Urdu: "a proper admin who can see everything — a list of
every agency, click one and its profile opens, all its agents, all leads, messages, meetings, everything;
and every agent the same way"). Decided with the user: admins read **everything** (team messages,
assistant chats and private notes included), **every page is recorded**, the console is **read-only**, and
it lives on an **admin.** host of the same console app.

## Context

Every actor lived inside one agency (`Actor.agencyId`, `sameAgency` in can()); there was no platform
role and no cross-agency read. Rule #9 says one console app; rule #2 says every decision is can().

## Decision

1. **Who.** `platform_admin` (user_id). Not a membership: a platform admin belongs to no agency, and every
   agency rule still refuses them. `loadPlatformAdmin` sets `Actor.platformAdmin`, which grants exactly one
   new action, `platform:read` (list agencies and people, open a view). Made and revoked only by
   `pnpm --filter @repo/db db:platform-admin` (Supabase sign-in created, password from the environment).
2. **The view.** `platformViewActor(admin, { agencyId, userId? })` returns an ordinary agency actor —
   the agency's owner (no `userId`), or that member with their own role and listings — marked
   `via: 'platform'` with `viewerId` = the admin. The existing core reads take it unchanged, so the admin
   sees what that owner or member sees, and the console reuses the agency console's reads and views.
3. **Read-only by construction.** can() refuses every action outside `PLATFORM_READ` (read verbs only)
   for a `platform` actor, before the action's own rule runs. No write function in core can run under a
   view; a test walks every action × role, and the smoke check proves writes change nothing.
4. **What an owner may not read.** Team conversations and assistant chats keep their participant/author
   rule for everyone else; the console reads them through `listPlatformTeamThreads` /
   `listPlatformAssistantChats`, which run only under a view. Nothing the console reads writes a read mark.
5. **Every read recorded.** `platform_view_log` (admin, agency, member, area, the row opened), written
   BEFORE the page reads; a page whose row cannot be written fails. The agency's profile shows its log.
6. **The host.** `resolveSurface`: `admin.` host or `CONSOLE_SURFACE_OVERRIDE=admin`. Pages under
   `/platform`, `/agencies`, `/agents` in the `(admin)` route group; middleware keeps the admin host to
   those (no sign-up there) and keeps the other hosts off them. Gate: `requirePlatformAdmin`.

## Consequences

- A cross-tenant reader now exists. Its blast radius is the `platform_admin` table: one row = every
  agency's data. Keep it to people the platform trusts, with a real mailbox and a strong password —
  "forgot password" mails the account's address, so an address someone else owns is a takeover.
  (The first admin was made with a dev address and a weak password — fine for dev; replace both before production.)
- No impersonation, no actions (suspend, edit) — a later ADR if wanted.
- Migration 0057 (two tables, RLS on, no grants).
