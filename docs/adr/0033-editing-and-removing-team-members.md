# 0033 — Editing and removing team members, by screen and by assistant

**Status:** ACCEPTED, 2026-10-10 (asked for by the user, decisions below from their answers).

**Context.** An owner or admin can invite an agent (ADR 0005) and remove one (ADR 0030), but
cannot correct a typo in an agent's licence number, change their territory or role, or take
back an invite sent to the wrong address. The user also wants the agency assistant to do the
same on request — finding the right person by name, asking when two people share a name, and
changing nothing until an owner or admin presses Approve.

## Decision

1. **One core function per change, shared by the screen and the assistant.**
   `editTeamMember` (packages/core/src/team/edit-member.ts) changes an active member's or a
   pending invite's details; `withdrawInvite` takes back a pending invite; removing an active
   member is ADR 0030's `removeMember`, unchanged. Each asks `can(actor, 'team:manage', …)`;
   the assistant's card runs the same function, which asks again.
2. **Fields** (the user's list): first/last/display name, email, phone, licence number,
   licence expiry, territory suburbs ("location") and operational role (senior, principal,
   property manager, cadet, custom — which also sets membership.role, as the invite wizard does).
   Commission, permissions flags and the public profile are not in this change.
3. **Email.** On a pending invite it changes the invite's address and rotates its token (the
   old link stops working; the new one is emailed when mail is configured, and is on screen
   either way). On an **active** member it is refused: the address is their sign-in, and an
   admin changing it to one they control could reset the password and become that agent. The
   agent changes it themselves (a later piece of work).
4. **Role.** Never your own; never an owner's (owners are changed by owners, ADR 0030); the
   role is the operational preset, and membership.role follows from it.
5. **"Delete"** (the user chose offboarding): an active member goes through ADR 0030 — their
   work to a chosen member or to the "Needs an owner" queue, restorable for 30 days. A pending
   invite is withdrawn (`status = revoked`); its link then says "This invite was withdrawn".
   Nothing is hard-deleted.
6. **Assistant (owners/admins only — agents are never shown these tools, and core refuses
   them).** `find_agents` (read) returns `M` references for members and `I` references for
   pending invites, with name, email, phone, licence number, expiry, territory, role and
   status, so the model can tell two people with one name apart — the prompt says: more than
   one match → list them with licence number and email and ask; never guess. `update_agent`
   and `remove_agent` only propose. The card shows each field before → after (from the
   database) and is refused at run time if a field changed since. `remove_agent` on a member
   needs a receiver (`give_work_to`, an `M` reference) or `leave_for_review` — without one the
   tool refuses and the model asks. Removing runs after the claim's transaction commits,
   because offboarding deletes calendar events and Zoom meetings over the network (CLAUDE.md:
   no network inside a transaction).
7. **Migration 0040** widens `proposed_action_tool_check` with `update_agent` and
   `remove_agent`. Numbered and dated after feat/meetings' 0039, which must be applied first.
