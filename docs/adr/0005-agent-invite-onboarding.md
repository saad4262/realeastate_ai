# ADR 0005 — Agent invite stores onboarding draft then claims membership

## Context
Agency Add-Agent wizard must persist identity, territory, licence, and role data. Auth user ids must match Supabase `auth.users`. Service role may be missing in early local setups.

## Decision
- Persist wizard payload on `agent_invite` (pending) with a claim token.
- On dispatch: always write invite; if `SUPABASE_SERVICE_ROLE_KEY` is set, also provision auth user + `user` / `membership` / `agent_profile`.
- Without service role: agent completes `/signup` with the invite email; `claimAgentInvite` links auth id and materialises rows from draft.
- Authorization always via `can(actor, 'team:manage', { type: 'team', agencyId })`.

## Consequences
Team directory reads membership + agent_profile. Signup must attempt claim. No `listing.agent_id`.
