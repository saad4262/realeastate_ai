# 0011 — A consumer is an actor with no agency

**Status:** accepted, 2026-09-26. Follows ADR 0010; unblocks consumer accounts (M4).

**Context.** Scheduled searches belong to a person who is not staff. Every
branch in `can()` except `console:agent`'s negative path requires an agency,
and `Actor` has only agency-shaped fields. The obvious move is to give a
consumer a `membership` row with a new `consumer` role, because then everything
existing keeps working.

**Decision.** A consumer is an `Actor` with a `userId` and **no** `agencyId`
and **no** `membershipRole`. No `membership` row, and no new value in
`membershipRoleEnum`. Ownership is expressed on the resource —
`Resource.ownerId` — and `schedule:read` / `schedule:manage` compare
`actor.userId` against it.

**Why not a membership.** `membership.agency_id` is `NOT NULL`, so a consumer
membership needs some sentinel agency to point at. `public.user_agency_ids()`,
added in migration 0001, returns every agency where the user has an active
membership, and the RLS policies on `listing`, `lead`, `media`, `property` and
others are all built on it. Every consumer would immediately be a member of
that sentinel agency for SELECT across all of them. That is a privilege
escalation rather than a modelling preference, and unwinding it once real
accounts exist is a data migration. `membershipRoleEnum` is also consumed by
`isAgencyAdminRole` and by the exhaustive `ROLE_PHRASES` map, both of which
would need a nonsense answer for `consumer`.

**Consequences.** `Actor` is unchanged — it already expressed a consumer, as a
userId and nothing else. `Resource` gains `ownerId`, the first non-agency axis
in the model. An agency owner is explicitly refused read and manage on a
consumer's schedule; that is the one place in `permissions.ts` where admin
power stops at the tenancy line instead of crossing it, so there is a test
saying so by name. `can()`'s `default: return false` became a `never` guard in
the same commit: adding an action used to compile and silently deny, and this
was the first change that would have been bitten by it.
