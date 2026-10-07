# 0030 — Tenant isolation and offboarding

**Status:** ACCEPTED, 2026-10-06. Not built. Decisions at the end ("Decided").

**Context.** About 100 agencies on one database (two apps, one packages layer — #9), each with
its own Zoom, Gmail, Google Sheets and Calendar connections, contacts, leads, conversations,
assistant history and proposed actions. Two promises have to be provable, not just intended:

1. **Agency A never sees or acts on agency B** — through any table, any core function, any
   route, any integration token, any cron job or any assistant tool.
2. **When a person leaves an agency, their access and their delegated power go with them** —
   tokens revoked, pending actions cancelled — and nothing they looked after is silently
   orphaned.

Today isolation is enforced in three layers: RLS on with no grants (the browser can read
nothing, ADR 0017); `can()` with `sameAgency` on every resource; and the agency filter in
every scoped SQL helper. What is missing is a suite that checks **all** of it systematically,
and any offboarding at all (membership has `invited | active | suspended`, and nothing acts on
a change).

## Decision — isolation

1. **Every table is classified, by a test that reads the schema.** A table either has
   `agency_id`, or reaches an agency through a parent row, or is deliberately shared — and the
   list of the last two is written down in the test, with the reason. Today (schema at
   migration 0029):
   - **has `agency_id`:** office, team, membership, agent_invite, listing, lead, mail_thread,
     mail_message, contact, note, activity, appointment, integration_account, ai_run, skill
     (null = platform library), agent_skill, skill_run, contact_filter, email_template,
     email_batch, assistant_conversation, proposed_action;
   - **through a parent:** team_member (team), listing_agent / media / inspection (listing),
     mail_read (mail_thread), contact_role / contact_property (contact), email_batch_recipient
     (email_batch), assistant_turn (assistant_conversation), agent_profile (user → membership);
   - **shared on purpose:** property and place_cache (one address is one property across
     agencies, ADR 0013 — never carries agency data), user, agency itself;
   - **consumer-owned, not agency data:** search_schedule, schedule_run, chat_thread,
     chat_message, shortlist, event.
   A new table that fits none of these fails the test until someone classifies it — the
   classification is the review.
2. **A two-agency fixture** (`isolationFixture`): agencies A and B, each with an owner, an
   admin, two agents and a read-only member, and at least one row in every agency-owned table
   above (listings in every status, leads incl. an offer, threads, contacts with notes —
   private and shared — appointments with fake Calendar/Zoom accounts, templates, a batch,
   skills, an assistant conversation with handles, a proposed action of each tool, and
   integration accounts of every provider and owner type).
3. **The matrix — every action, as every role of A, against B's rows.** Generated, not
   hand-listed:
   - **Core reads:** a registry of every exported read function (`list*`, `get*`, scoped
     helpers) with how to call it; each is called as each A actor and must return none of B's
     ids (asserted by id, against the fixture's known B ids).
   - **Core writes:** every exported write function is called as each A actor with B's ids
     and must throw not-found/forbidden **and change nothing** (a row-count and `updated_at`
     snapshot of B's rows before and after).
   - **`can()` exhaustively:** every `Action` × every A role × a B resource of that type →
     false (a unit test that iterates the `Action` union).
   - **Routes:** every console route handler and server action, called with an A session and
     B's ids (the HTTP smoke group) → 404/403, never 200 with data.
   - **Integration tokens:** `tokensForUse`, `withAccessToken`, `resolveIntegration`,
     `requireIntegrations` and every sync/send path, as A, can never resolve, decrypt or use a
     B account — including B's *agency-level* Zoom/Gmail/Sheets that "any member may use"
     within B. The AAD on each ciphertext (row id + column, ADR 0020) is checked by moving a
     B ciphertext into an A row and asserting decryption fails.
   - **Assistant tools:** every read and write tool, run as A with B's ids **injected into A's
     handle map** (simulating a forged reference) → empty results or "not available"; every
     approve/reject/cancel of a B proposed action as A → not found. Budget sums never include
     B's spend in A's agency cap.
   - **Cron jobs:** the tick's jobs (schedules, skills, template sends, appointment sync,
     assistant purge/expiry) each run over the fixture and are asserted to act on each row with
     **that row's** agency and owner — e.g. a B appointment syncs with a B token only.
   - **Database closed to the browser:** the existing smoke check (no grants, RLS on every
     table, no open policy) stays.
4. **Where it runs.** The schema classification, the `can()` matrix and the forged-handle
   checks are unit tests (`pnpm test`, offline). The fixture matrix is a smoke group
   ("Tenant isolation"), in one rolled-back transaction, under a time budget. Both must be
   **break-tested**: remove the agency filter from one read, `sameAgency` from one `can()`
   case, and the AAD from encryption — each must go red.

## Decision — offboarding

5. **"Remove from agency" is an admin action, `team:manage`, never on yourself, never the last
   owner.** It does, in this order (network steps before or after the transaction, never
   inside it):
   1. **Decide where their work goes** — the admin picks a member to receive it, or "leave
      unassigned for review". The screen first shows counts from SQL: upcoming appointments,
      assigned contacts, assigned leads, listings where they are a listing agent (and those
      where they are the *only* one), their pending imports, prepared email batches,
      dashboards, agency-level integrations they connected.
   2. **Move their upcoming appointments' calendar events while their token still works:**
      reassign each upcoming appointment (or, if "unassigned", cancel nothing — flag it) and
      run `syncAppointment`, which deletes the event from the leaver's calendar and creates it
      in the new agent's. Zoom meetings on the leaver's Zoom are recreated on the new agent's
      or the agency's Zoom (new join link → the appointment is flagged "Zoom link changed —
      resend the invitation"). Network, before the transaction.
   3. **One transaction:**
      - `membership.status = 'suspended'`, `removed_at`, `removed_by` (additive columns);
      - reassign (or set `assigned_to = null` + `needs_owner_at`) on their contacts and leads;
        appointments not moved in step 2 get `needs_owner_at`;
      - `listing_agent` rows removed; a listing left with no agent gets the receiving member
        or is flagged (the existing smoke check "no listing is left without an agent");
      - every `proposed_action` of theirs in `proposed` / `scheduled` → `cancelled` (reason
        "person removed from the agency"), with `activity` rows; every `email_batch` of theirs
        in `prepared` → `cancelled`; `agent_skill` rows disabled; `listing_import` jobs not done
        → `cancelled`;
      - their `assistant_conversation` rows deleted (author-only history, ADR 0025 Q5);
      - an `activity` / audit row "Removed from the agency by <admin>".
   4. **Revoke then delete their user-level integration tokens** (Calendar, Zoom, Gmail,
      Sheets): revoke at the provider (best effort, as Disconnect does), then delete the rows.
      **Agency-level** accounts they connected are NOT deleted (they are the agency's), but are
      flagged for an admin: "Connected with <leaver's Google/Zoom account> — reconnect with an
      account the agency controls" (we record `connected_by` on agency-level accounts:
      additive column).
   5. **Sign them out of this agency:** their next request has no active membership, so
      `loadActor` returns no agency and every `can()` refuses; their open console session shows
      "You no longer have access to <agency>". The Supabase account itself is not deleted (it
      may be a buyer account on the public site too).
6. **What is kept.** Everything they wrote that belongs to the agency stays and still shows
   their name: notes (including private ones — readable by admins as before), sent mail,
   activity, approved actions, created dashboards (`created_by` → kept for history; manage
   passes to admins). `ai_run` rows stay (the platform's accounting; `user_id` stays set until
   the user row itself is deleted).
7. **A "Needs an owner" queue** for admins: contacts, leads, appointments and listings flagged
   by an offboarding, each with Assign. It shows on the agency overview until empty.
8. **Suspended, not deleted,** so an admin can **restore** a mistaken removal within 30 days:
   the membership comes back; tokens do not (they must reconnect), cancelled actions stay
   cancelled, reassigned work stays reassigned.

## Permissions (all through `can()`)

- `team:manage` (exists, owner/admin) — remove, restore, and the reassignment screen.
- `team:remove_owner` — new: only an owner may remove another owner; never the last owner.
- The "Needs an owner" queue: `contact:assign` / `lead:assign` / `appointment:assign`
  (existing, admin) for each row.
- A suspended member fails every `can()` (no active membership) — tested in the matrix.

## When something is not connected / reachable

- **The leaver's Google/Zoom token already expired:** step 2 cannot delete their calendar
  events or Zoom meetings. The new agent's events are still created; the screen lists "Could
  not remove N events from <leaver>'s calendar — they may still see them" (we no longer hold a
  working grant, by design).
- **The receiving member has no Calendar/Zoom connected:** their appointments are reassigned
  without a calendar event and show the usual "Connect Google Calendar" note; Zoom
  appointments that need a new meeting are flagged "Connect Zoom first" on the appointment.
- **Provider revoke fails** (network): the row is still deleted; the admin screen says
  "Google did not confirm the revoke — <leaver> can remove the app from their Google account".

## Failure cases

| Case | What happens |
|---|---|
| Admin removes the last owner | Refused before anything happens. |
| Removal interrupted after step 2 | Step 2 is idempotent (sync by our own event id); re-running the removal continues. Nothing is suspended until the transaction commits. |
| A proposed action of theirs is mid-approve (`running`) | Removal waits for the row lock; the action finishes or fails, then cancellation applies to what is left. |
| They are approving a card at the moment of removal | The approve re-checks `can()` in its own transaction; whichever commits first wins; after removal every approve refuses. |
| Same person is a member of two agencies (if allowed later) | Offboarding acts only on rows of the agency doing the removing; their other agency's tokens are untouched (user-level tokens would then need to be per agency — open question 4). |
| A scheduled cron job of theirs fires after removal | Every job re-checks the actor's membership at run time (skills, template sends, delayed assistant runs) and skips with "person no longer in the agency". |

## Tests to write

- Unit: schema classification test (every table classified); `can()` matrix over every
  `Action` × role × cross-agency resource; forged-handle refusals for every assistant tool;
  AAD swap fails decryption.
- Smoke group "Tenant isolation" (two-agency fixture, rolled back): every registered read
  returns none of B's ids; every registered write with B's ids throws and changes nothing;
  every route with an A session and B ids → 404/403; every cron job acts only with the row's
  own agency and tokens; A's assistant budget never counts B.
- Smoke group "Offboarding" (fake Google/Zoom): removing A's agent moves upcoming events to the
  receiving agent's calendar (fake provider shows delete + create), recreates the Zoom meeting
  and flags the invitation; cancels their proposed actions, prepared batches and imports;
  disables skills; deletes their conversations; revokes then deletes their user-level tokens;
  flags agency-level accounts they connected; flags listings left without an agent; the
  removed member's next `loadActor` has no agency and every action refuses; restore within 30
  days brings the membership back without tokens.
- **Break-tests:** drop the agency filter from one read helper → red; let `sameAgency` pass on
  null agency → red; skip token deletion → red; cancel actions before moving events (token
  gone) → red; forget `scheduled` actions → red.

## Open questions (recommended answer first)

1. **Default for the leaver's work** — *the admin must pick a receiving member or explicitly
   choose "leave unassigned for review"*; no silent default.
2. **Their assistant conversations** — *delete at removal* (author-only history; their actions
   stay in `proposed_action` as the audit).
3. **Restore window** — *30 days*; after that the membership row stays suspended for history
   but restore is no longer offered.
4. **One person in two agencies** — *not allowed for now* (one active membership per user);
   if it is ever allowed, user-level tokens become per membership.
5. **Agency leaving the platform** (all members) — *a separate, owner-requested closure with a
   data export and deletion schedule*, its own ADR before the first agency ever leaves.
6. **Who sees the "Needs an owner" queue** — *owners and admins*, on the agency overview.
7. **Isolation suite in CI** — *the unit parts in `pnpm test` on every push; the smoke group
   before every deploy* (it needs a database).
8. **Agency-level accounts connected by the leaver** — *keep working but flagged* until an
   admin reconnects with an account the agency controls (forcing a disconnect would break the
   agency's Zoom for everyone mid-day).

## Decided (2026-10-06)

- **Q1 (the user): the admin must choose** who receives a removed person's work, or explicitly
  choose "leave unassigned for review". There is no silent default, and Remove stays disabled
  until a choice is made.
- **Q4 (client): an agent may not belong to two agencies at once.** One active membership per
  user, enforced in the data (a unique partial index on `membership(user_id) where status =
  'active'`, additive) and in invite acceptance ("This person already belongs to another
  agency"). User-level tokens therefore stay per user.
- Q2, Q3, Q5, Q6, Q7, Q8: **accepted as recommended** (conversations deleted at removal; 30-day
  restore; agency closure gets its own ADR before it happens; owners and admins see the
  "Needs an owner" queue; unit parts in `pnpm test`, the smoke group before every deploy;
  agency-level accounts connected by the leaver keep working, flagged for reconnection).

## As built — offboarding (Phase 8, 2026-10-06)

- **Migration 0035** (additive): `membership.removed_at / removed_by / removal_report`;
  `needs_owner_at` on contact, lead, appointment and listing;
  `integration_account.connector_left_at`; the unique partial index
  `membership_one_active_idx` (one active membership per user — dev data checked first: no
  violations).
- **`removeMember(db, actor, userId, choice, deps)`** (`packages/core/src/team/offboarding.ts`):
  `team:manage`; another owner needs **`team:remove_owner`** (owners only). Never yourself,
  never the last owner (checked before and again inside the transaction). The choice is
  required: `{ receiver }` (an active member who may write) or `{ review: true }`.
  1. Network first, with the leaver's own token: upcoming appointments' Google events and
     meetings on the leaver's **own** Zoom are deleted. A meeting on the agency's Zoom is
     left alone. A failure (expired grant) is counted: "they may still see them".
  2. One transaction: membership suspended; contacts, leads and upcoming appointments go to
     the receiver or get `needs_owner_at` (contacts get an `owner_left` timeline row).
     Removed events/meetings are cleared on the row, and a `zoom_link_changed` row is added
     where the link will change. Their `listing_agent` rows go; a listing left with nobody
     gets the receiver or is flagged. `proposed`/`scheduled` cards are cancelled (with
     timeline rows), `prepared` batches cancelled, unfinished imports cancelled, skills
     disabled, assistant conversations deleted, and agency accounts they connected get
     `connector_left_at`.
  3. Their user-level accounts: revoke at the provider (best effort, reported), then delete.
  4. Moved appointments sync into the receiver's calendar/Zoom. The report is stored on the
     membership.
- **`restoreMember`**: within 30 days. Tokens do not come back; moved work stays moved. If
  they joined another agency since, it is refused (the index).
- **Needs an owner**: `listNeedsOwner` (owners/admins) on the agency Overview;
  `assignNeedsOwner` assigns through each screen's own assign function (contacts, leads),
  or `appointment:assign` + sync, or the listing-agent writer (`listing:publish`). An item
  someone assigns elsewhere drops out of the queue by itself.
- **One agency per person**: `claimAgentInvite` refuses (`other_agency`, with a sentence on
  the sign-in and invite screens) before anything is written. The index is the backstop.
- The DB-health smoke check "no listing is left without an agent" now excludes listings
  flagged `needs_owner_at`, as this ADR specified.
- Not built: the console banner "You no longer have access to <agency>". The removed
  person's next request already has no agency (`loadActor` requires `active`) and lands on
  sign-in / get-started.
