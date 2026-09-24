# ADR 0006 — Self-serve agency registration; identity always from the session

## Context
After demo data was removed there was no way into the console: signup created an
`auth.users` row but never mirrored `public.user`, so `membership` could never exist and
`can()` denied every surface. Separately, `claimAgentInviteAction` accepted `userId` and
`email` as client arguments — a caller could mint a membership for any account.

## Decision
- `/signup` has two modes: **agency** (self-serve) and **invite** (token from Add-Agent).
- Agency mode calls `registerAgency()` in `packages/core/agency/` — one transaction writing
  `agency` + `office` + `user` (mirror) + `membership(role=owner, status=active)`.
- Every server action derives identity from the Supabase session (`requireUser()`), never
  from client-supplied `userId`/`email`. Invite claim matches on the session user's own email.
- `ensureAppUser()` mirrors `auth.users` → `public.user` on every authenticated entry, so a
  membership always has a user row to reference.
- `membership` gains `unique(user_id, agency_id)`; claim/registration are idempotent upserts.

## Alternatives
- Invite-only signup with a bootstrap script — rejected; every new agency needs a manual step.
- Postgres trigger on `auth.users` → `public.user` — rejected; hides the write from Drizzle,
  which ADR 0001 makes the source of truth.

## Consequences
Dev has "Confirm email" off, so signup returns a session immediately; the confirm-pending
branch is still handled. Seed no longer invents UUIDs — it provisions via service role or
does nothing. Cross-tenant permission tests cover registration and claim.
