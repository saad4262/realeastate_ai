# Status
- Milestone: **M6 — email conversations live in the app (ADR 0016).** Every lead
  is a conversation an agency can read and answer in the console; buyers read
  theirs on the website; replies from Gmail land back in the same thread.
  Built on M5 (sold properties, private offers, the lead inbox).
- **Now: Agent Assistant Phases A, B, C committed on `feat/crm`** (7d6434c A read-only,
  126f9ee B notes + next action, Phase C appointments in the commit after it). Migrations 0028 and
  0029 applied on dev (additive). Waiting for the user's walk-through of TEST-PLAN U and V.
  **Not started (by instruction): Phase D** (template email from picked contacts), then
  E (delayed run, needs the 5-min cron) and F (widgets hook).
- **Dev allowlist fix (ADR 0025 Q6) committed (6238739):** `EMAIL_DEV_ALLOWLIST` now gates
  every platform-composed email (`mail_message.kind` set: template email, appointment
  invitation) in the shared `deliverOutbound`. A person's own typed reply is not gated.
  **Your `.env.local` still has no `EMAIL_DEV_ALLOWLIST`** → invitations in dev are refused
  ("not on the development allowlist") until you add your test addresses.
- **CRM Phase 3b — real Google Calendar + Zoom (ADR 0020 "Phase 3b", migration
  0027) on `feat/crm`.** Real Google Calendar Connect verified end to end by the user
  on agents.lvh.me (2026-10-06) after the OAuth return-loop fix (commit 00c60a8).
  Zoom not yet tried with real credentials; TEST-PLAN T is the walk-through.
  Template email (ADR 0022, TEST-PLAN S) before it, also awaiting review.
  Not started (by instruction): Google Sheets, Google Reviews, Phase 6, Phase 7.
  Plan: `~/.claude/plans/pasted-content-id-f0ff-you-are-functional-frost.md`.
- Build order (locked): Agency UI → Agent UI → Consumer web
- Last tool: Claude Code
- Last updated: 2026-10-06
- Deploying: `apps/web` only, Vercel Hobby. `apps/console` waits for a real
  domain — see `docs/DEPLOY.md`. **Nothing is deployed yet.**

## Agent Assistant — Phases B and C, proposals you approve (2026-10-06, ADR 0025, migration 0029)

- `proposed_action` (frozen resolved args, card snapshot, idempotency key per model tool
  call, 48 h expiry, kept as audit). Permissions `proposed_action:read` (author, admin),
  `:decide` (author only), `:cancel` (author or admin).
- Write tools ONLY PROPOSE: `add_note`, `set_next_action` (B); `schedule_appointment`,
  `reschedule_appointment`, `cancel_appointment` (C). Handles only, can() at propose, card from
  the DB, at most 3 per answer. Bookings go on the person's own calendar: Google Calendar
  required (+ Zoom for a Zoom type) or "Connect … first" with no card. No invitation is ever
  sent; the card points to Calendar → Send invitation.
- Approve = one transaction: claim (proposed, unexpired, author's) → run through the screen's
  own core function (re-checks can()) → done or failed-with-reason; appointment sync after
  commit. Double click = one write. Reject, Cancel, cron expiry.
- Audit: activity `assistant_proposed/_approved/_rejected/_cancelled/_failed` (no text); a
  private note's proposal visible only to author + admins on the timeline.
- Panel: cards read back by id, Approve / Reject (Cancel for admins once delayed runs exist).
  Prompt `assistant@v3`.
- Tests: core 22 + ai 16 assistant unit tests, permissions, smoke "Console assistant" 10/10
  (matrix, double approve, access lost, calendar lost, expiry, private note, injection), and 21
  guards broken in a separate worktree, all seen red. Contacts 12/12, Appointments 3/3,
  Calendar/Zoom 5/5. Typecheck 10/10, lint 0 errors, test 747 + 286.
- Not done: card text editing before approve; no live model call yet (TEST-PLAN U/V are the first).

## Agent Assistant — Phase A, read-only (2026-10-06, ADR 0025, migration 0028)

- Tables `assistant_conversation` (author-only, handle map, one-turn claim, 30-turn cap) and
  `assistant_turn` (text, answer, SQL frames, exact API messages for append-only replay;
  failed turns shown, never replayed). `ai_run.agency_id`. RLS on, no grants.
- Permissions `assistant:use` (any active member) and `assistant_conversation:read` (author
  only, not admins).
- Core `@repo/core/assistant`: zod contract, handles (C/L/A/T/S; the model never sees an id),
  5 read tools each ONE statement through the screens' scope (`find_contacts`, `find_leads`
  — never offers, `find_appointments`, `list_templates` — approved, `check_connections`),
  caps ($1/person, $10/agency, inside AI_DAILY_BUDGET_USD; the skills' per-user cap no
  longer counts assistant spend), purge after 30 days (cron tick).
- AI `@repo/ai/assistant`: Sonnet 5.5 via ANTHROPIC_SKILL_AGENT_MODEL, streamed, adaptive
  thinking + `drop_block`, effort low, `fallbacks: "default"`, frozen prompt `assistant@v1`,
  date in a `<console_context>` user block, budget before every request, 8 tool calls/turn.
- Console: Assistant button + right panel on both surfaces, `/api/assistant` (NDJSON),
  History, "Using this contact". Label "Written by the assistant".
- Tests: core 16 + ai 14 unit (incl. red-team: invented tools, foreign/invented references,
  ids/names as references, a selected name closing the context tag, the 8-call cap, budget per
  request, no date in the prompt), permissions 2, smoke group "Console assistant" (6), one
  opt-in live red-team check in `pnpm smoke:ai`. 9 smoke + 11 unit guards broken in a separate
  worktree and seen red (two needed both of their layers broken).
- Numbers: typecheck 10/10, lint 0 errors, test 740 + 284, console production build OK
  (throwaway dist dir). Full `pnpm smoke` not run (user's dev data); groups run: Console
  assistant 6/6, Database 30/30, Appointments 3/3, Template email 5/5, Email conversations 7/7.
- Not done: no live model call has been made (TEST-PLAN U is the first); not clicked in a browser.

## Decisions from the client/PM (recorded 2026-10-05 — not built)

1. **Zoom:** each agent connects their own Zoom; an admin connects the agency Zoom.
   Letting other people's accounts connect needs the app approved/published on the Zoom
   Marketplace — check Zoom's docs in 3b. Tunnel for Zoom only if it refuses localhost.
   → ADR 0020 "Decided".
2. **Google:** ONE app (Calendar, Sheets, Reviews), permissions asked incrementally.
   Until verified, only test users can connect and tokens expire after ~7 days.
   Verification needs a domain, a homepage and a privacy policy. Least privilege:
   Sheets reaches only the picked file, never all of Drive. → ADR 0020 "Decided".
3. **Google Reviews, two steps:** first the Places API with the existing Google key
   (rating, count, a few recent reviews, Google attribution — check the Places terms on
   storing reviews); later the Business Profile API for all reviews. Business-level only;
   agent profiles show the agency's reviews; a review is linked to a contact only by an
   admin's manual "Link to contact", otherwise "Unmatched". Review requests by email with
   preview + approve; no incentives, no review gating. → ADR 0023 (planned).
4. **CSV listings import:** an owner/admin import goes live directly (option: import as
   draft); an agent import goes through submit-for-approval. Waiting for the sample CSV
   and the photo format. → ADR 0024 (planned).
5. **Domain and paid hosting come after testing.** Until then: nothing deployed, Google
   stays in Testing, no Zoom Marketplace publishing.
6. **Template-email skill** (ADR 0022): owner/admin-approved templates only; manual
   Prepare → Approve & Send, no scheduled sending; recipients frozen at Prepare, shown in
   full with skips and reasons, opt-out/consent re-checked at send; 48 h expiry.
7. Earlier, still standing: one person = one contact with role tags; agents see only
   what they could already open; phone matches are suggestions; enquiries are not
   marketing consent; read-only members view only and connect nothing.

## CRM Phase 3b — real Google Calendar and Zoom (2026-10-06, ADR 0020, migration 0027)

- Env: `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `ZOOM_OAUTH_CLIENT_ID/_SECRET`,
  `ZOOM_OAUTH_RETURN_BASE` (dev tunnel — Zoom refuses localhost for apps with a secret).
  Redirects: Google `http://localhost:3001/api/integrations/oauth/return`; Zoom
  `https://<tunnel>/api/integrations/oauth/return`. A provider with both values set is
  real; otherwise the stub (dev) — the stub stays for tests.
- Scopes: Google `calendar.events.owned` + `openid email`; Zoom
  `meeting:write:meeting meeting:update:meeting meeting:delete:meeting user:read:user`.
- OAuth: PKCE (no storage), renewal before expiry and on 401, Zoom's rotating refresh
  token stored by compare-and-swap, a dead refresh token → account `expired` →
  "Expired — reconnect". Disconnect revokes at the provider first.
- Appointments mirror OUT (sync.ts): acting as the assigned agent — their calendar;
  their Zoom else the agency's. Book/reschedule/complete/cancel → event created /
  moved / "✓ title" / deleted; Zoom meeting created / moved / deleted. No attendees,
  sendUpdates=none: Google emails nobody. One run at a time + our own event id: a
  double submit makes one event and one meeting. Only the Zoom join link is kept
  (never start_url or passwords).
- Read-back IN: the 5-minute cron `events.get`s our own upcoming events with their
  ETag; a move/deletion in Google is flagged ("Keep ours" / "Use Google's time"),
  never copied. Crashed syncs (`pending`) are resumed by the same tick.
- Console: card shows "Google Calendar · synced <time>", failures with Retry,
  conflicts, Join Zoom; Schedule panel says which Zoom hosts it or "Connect Zoom
  first" (Book waits unless a link is pasted; the server refuses too).
- Smoke: 5 checks with a fake Google/Zoom; `SMOKE_ONLY=<group>` runs one group.
- NOT verified against the real Google/Zoom yet (no credentials). Known limits in
  ADR 0020: an orphan Zoom meeting if the process dies mid-create; events stay in
  Google after a disconnect; Sheets + Calendar sharing one Google grant — check later.

## Template email to contacts (2026-10-05, ADR 0022, migration 0026)

- Tables `email_template` (draft → pending_approval → approved → retired),
  `contact_filter` (saved directory filters), `email_batch` (frozen template
  + filter snapshot, 48 h expiry), `email_batch_recipient` (frozen name/email,
  status queued|sending|sent|failed|skipped, skip reason, thread + message).
  RLS on, no grants. Applied on dev (additive only).
- Permissions: agents draft templates; only owner/admin approves/retires;
  a batch is seen by its author and admins; only its author sends; author or
  admin cancels; saved filters are personal.
- Flow: approved template + saved filter → Prepare (recipients frozen, every
  skip shown with its reason) → Approve & Send (guarded update — a second
  press sends nothing). No scheduled sending. Expired after 48 h.
- At send: consent, opt-out, archive, email change, 7-day repeat, daily caps
  and the dev allowlist re-checked per recipient. Limits from env (20/batch,
  50/agent/day, 200/agency/day, 7 days, 500 ms between messages). Each email
  is a conversation (thread + mail_message kind `template_email`), with the
  agency sender, a contact `/unsubscribe` link + List-Unsubscribe, and a
  timeline row. Retry re-delivers only failed recipients. Cron expires old
  batches, recovers stuck "sending" rows, resumes interrupted batches.
- `EMAIL_DEV_ALLOWLIST`: outside production only listed addresses/@domains
  are sent to (unset = nobody); production ignores it. `.env.example`,
  DEPLOY.md, smoke check.
- Skills library lists "Template email to contacts" → "Open bulk email";
  the runner refuses to schedule or run it (manual only).
- Console: /bulk-email (agency), /my-bulk-email (agent), template pages,
  batch page, "Save this filter" on the contact directory.
- Smoke: 5 checks (unapproved template, frozen list, opted-out at send,
  double approve/send, limits + allowlist, expiry + other agent's batch),
  each broken and seen red.
- **Your `.env.local` has no `EMAIL_DEV_ALLOWLIST`** → in dev every
  recipient is skipped until you add your own test addresses.

## CRM Phase 5 — skills (2026-10-05, ADR 0021, migration 0025)

- Before skills: the console REFUSES TO START in production with
  `INTEGRATIONS_STUB=1` or no/malformed `INTEGRATION_TOKEN_KEY`
  (instrumentation.ts; verified by starting a production build three ways).
  DEPLOY.md: own production key, losing it = everyone reconnects, rotation.
- Tables `skill` (library; agency_id null = built-in; handler fixed in code;
  Markdown body with front-matter `requires`/`model`/`schedule`),
  `agent_skill` (an agent's copy: own body, on/off, schedule + IANA zone,
  email-me), `skill_run` (status, summary + source, structured result, cost
  via ai_run.entity_id). Two built-ins seeded. Applied on dev.
- Permissions `skill:read|curate`, `agent_skill:read|manage` (own only; not
  even admins see another person's skills; read-only cannot add).
- Runner: claim (SKIP LOCKED + unique slot), nextRunFor, 3 failures pause;
  per run: member → requireIntegrations (library ∪ copy requires) → budget
  (skipped, no model call) → gather AS THE AGENT → model → citation check →
  store → optional email to the agent. In the existing cron tick.
- Citations (`skills/citations.ts`): every sentence cites a given record;
  numbers only when quoted verbatim from a cited record; else template.
- Models: `claude-sonnet-5-5` ($2/$10) and `claude-opus-5-5` ($4/$20) priced;
  tiers via ANTHROPIC_SKILL_{SUMMARY,AGENT,HARD}_MODEL (Haiku 4.5 / Sonnet 5.5
  / Opus 5.5). Both skills use the summary tier. The Claude API reference
  recommends server-side `fallbacks` for Sonnet/Opus 5.5 — add it when the
  agent tier is first used (not now: Haiku only).
- Console: /skills (+ library/new for admins), /my-skills, detail (editor,
  on/off with "Connect X first", schedule on the agent's clock, run now,
  history with cost), result page with clickable citations. Nav links.
- Vercel Pro cron: `*/5 * * * *` on /api/cron/alerts (DEPLOY.md).
- Numbers: typecheck 10/10, lint 0 errors, test 677 + 270, build 2/2, smoke
  149 passed / 1 failed (known dev account). Four skills smoke checks, each
  break-checked red.
- Not clicked in a browser: R. No live model call was made by any test.

## CRM Phase 4 — integrations hub (2026-10-05, ADR 0020, migration 0024)

- `integration_account` (applied on dev): provider, owner_type user|agency,
  owner_id, agency_id, label, granted scopes, status, last sync / error,
  AES-256-GCM token columns (key `INTEGRATION_TOKEN_KEY`, AAD = row + column,
  rotation via `_PREVIOUS`). RLS on, no grants. CHECKs: who may own which.
- Permissions `integration:read|manage|use`: own user-level; agency-level
  managed by owner/admin only, seen and used by members. Nobody reads anyone
  else's tokens; no screen read selects a token column.
- `requireIntegrations` (Zoom: own → agency; Calendar: own; Reviews: agency;
  Sheets: own → agency) + `ConnectFirst` card, wired into the contact
  Calendar tab and /calendar.
- OAuth plumbing: signed, user-bound, 10-minute state; one return route
  `/api/integrations/oauth/return` (public; on localhost it hops to the
  console host the state names); scope re-check → `permission_missing`.
  Dev stub provider (`INTEGRATIONS_STUB=1`, never in production).
- Pages: `/settings` (index), `/settings/integrations`, `/my-integrations`
  (agent nav). Disconnect deletes the row and its tokens.
- `.env.local` on this machine now has a generated `INTEGRATION_TOKEN_KEY`,
  `INTEGRATION_OAUTH_RETURN_BASE=http://localhost:3001`, `INTEGRATIONS_STUB=1`.
- Numbers: typecheck 10/10, lint 0 errors, test 660 + 263, build 2/2, smoke 145
  passed / 1 failed (known dev account). Four new smoke checks, each
  break-checked red (the user-binding one only after it was tightened).
- NOT SURE (ADR 0020): one Google app or three; Zoom's http/localhost redirect
  rules; exact scope names (verify in 3b).

## CRM Phase 3a — appointments (2026-10-05, ADR 0019, migration 0023)

- `appointment` table (applied on dev): contact, optional related property,
  assigned agent, type, status, UTC instants + booking zone, location / link,
  internal notes, outcome, attendees (JSON), reminder choice (stored only),
  empty external_calendar_* / zoom_meeting_id for 3b. `mail_message.kind`.
- Permissions `appointment:read|read_all|create|update|assign`: admin all;
  others own (assigned or booked by them); read-only views only. SQL twin
  `appointmentScopeFilters`.
- Complete / cancel / reschedule with outcome; each change an `activity` row.
- Invitation email: opt-in, exact preview, explicit Send, via the conversation
  pipeline (a new conversation with the contact), transactional, never the
  internal notes. Counts toward `EMAIL_LIMIT_PER_AGENT_DAY` (50) /
  `EMAIL_LIMIT_PER_AGENCY_DAY` (200), which count `mail_message.kind` rows only.
- Times: `@repo/core/time` converts typed wall-clock ⇄ instants in a NAMED zone
  (the browser's); the UTC-pinned test fails on the naive `new Date(typed)`.
- Console: contact Calendar tab (Upcoming/Past, Schedule side panel, Google +
  Zoom "Not connected"), `/calendar` (agency, agent filter), `/my-calendar`
  (agent; replaces the dead "Inspections" link). Day-grouped list, no library.
- Merging contacts now moves appointments too.
- Numbers: typecheck 10/10, lint 0 errors, test 645 + 263, build 2/2, smoke 141
  passed / 1 failed (known dev account). One earlier smoke run had 12 HTTP
  failures from the web dev server recompiling after `pnpm build`; a re-run was
  clean. Three new smoke checks, each break-checked red.
- Not clicked in a browser: TEST-PLAN P.

## CRM Phase 2 follow-up (2026-10-05, migration 0022)

- `note.is_private` (applied on dev). Private notes: admins + author only, on
  the Notes tab, timeline and counts (`noteVisibleSql`). Ask the client if
  that is enough.
- Link a contact to a brand-new address with the listing form's address
  picker (`linkContactNewAddress`); existing properties are never changed
  (`upsertProperty` `leaveExisting`). TEST-PLAN O14–O15.
- Numbers: typecheck 10/10, lint 0 errors, test 625 + 263, build 2/2, smoke
  138 passed / 1 failed (known unmirrored dev account). Two new smoke checks,
  each break-checked red.

## CRM Phase 2 — Contact 360 (2026-10-05, ADR 0018 addendum)

- Migration 0021 applied on dev (additive): `contact.archived_at/_by`,
  `note.deleted_at/_by`.
- Profile tabs: Overview (facts, next-action quick edit, counts, recent
  activity, duplicates + Merge), Timeline (one UNION query, cursor paging),
  Properties (ties + enquired addresses → /property/[id]; link/unlink known
  addresses), Emails (inbox ThreadList/ThreadReader reused), Enquiries
  (LeadTable `compact`), Notes (add/edit/soft-delete), Calendar and Reviews
  ("Not connected").
- Every tab and count uses the inbox's own scope (`leadScopeFilters`,
  `threadScopeFilters`, factored out of list-leads/threads).
- Archive/restore + "Archived" directory filter. Contact-assigned email
  (`notifyContactAssigned`), not on self-assignment.
- The backfill was NOT applied when the user reported it; applied 2026-10-05
  by Claude Code (4 leads → 4 contacts). Section N must be re-tested.
- Numbers: typecheck 10/10, lint 0 errors, test 624 + 263, build 2/2, smoke
  136 passed / 1 failed (known unmirrored dev account). Five new smoke checks,
  each break-checked red.
- Not clicked in a browser: TEST-PLAN sections N and O.

## CRM Phase 1 — contacts (2026-10-05, ADR 0018)

- **Migration 0020 applied on dev** (additive): `contact`, `contact_role`,
  `contact_property`, `note`, `activity`; `lead.contact_id`,
  `mail_thread.contact_id`; `au_phone_key` (generated `phone_key`);
  `contact_upsert` + BEFORE INSERT triggers on `lead` and lead-less
  `mail_thread`. Same email = same person (fills blanks, never overwrites);
  same phone = duplicate SUGGESTION only. `event` left untouched.
- **Backfill applied 2026-10-05** (see Phase 2). Was:
  `pnpm --filter @repo/core contacts:backfill` (dry run: 4 leads → 4 contacts
  on dev) then `... --apply`. Smoke "every lead and conversation has its
  contact" is red until then.
- Permissions: `contact:read|read_all|create|update|assign|merge`,
  `note:create|manage`. Visibility = can() + `contacts/visibility.ts`, held
  together by a smoke parity check. Agents edit only contacts assigned to them;
  read-only views only. Agency-address mail from a contact is now readable by
  whoever sees the contact and answerable by its assignee.
- Consent: `marketing_consent_at/_by/_note`, `email_opt_out_at`. An enquiry is
  not consent.
- Console: `/customers` (+ `/new`, `/[id]`) and `/my-contacts` (agent nav
  "Contacts"). Profile is the Phase 1 card; Contact 360 tabs are Phase 2.
- Not clicked in a browser: TEST-PLAN section N.
- Numbers: typecheck 10/10, lint 0 errors, test 619 + 263, build 2/2,
  smoke 130 passed / 2 failed (backfill not applied; known unmirrored dev
  account). New checks break-checked red: SQL/can() parity, trigger
  never-overwrites, agency mail reaching the contact's agent.
- 0019 applied on dev 2026-10-05; the live Data API refuses the anon key on
  every table (curl-verified). No browser code uses `.from()`/`.rpc()` — the
  user may switch the Data API off.

## CRM Phase 0 (2026-10-05)

- M6 committed on `main` (3 commits); CRM work on `feat/crm`.
- **Migration 0019 — applied on dev after review** (ADR 0017, "the server is the only
  door"): `anon`/`authenticated` held ALL privileges on every public table,
  4 tables had no RLS, and policies let any member update any listing and read
  every offer/email through the Data API. 0019 revokes the grants (and the
  default ones), turns RLS on everywhere, drops the wide policies. Dry-run in a
  rolled-back tx: 0 grants left, `authenticated` refused. Smoke check "the
  public schema is closed to the browser keys" is RED until 0019 is applied —
  apply with `pnpm --filter @repo/db db:migrate` once approved.
- `/overview` carries a "Demo data" banner; the fake AI briefing is labelled a
  sample. `.env.example`/env.ts/DEPLOY/CLAUDE.md: media is Supabase Storage;
  the model default lives only in `packages/ai/src/models.ts`;
  `ANTHROPIC_ALERT_MODEL` declared.
- Email: sending is from verified `quotemydecking.com.au`; receiving on the
  `*.resend.app` address. A real round trip (console reply → Gmail → back into
  the thread) worked on 2026-10-03. M5, M7–M13 still to click through.
- Smoke 125 passed / 2 failed: the 0019 check (expected) and "every account is
  mirrored" (dev account that has not opened a page since the fix).

## What M6 added (ADR 0016)

**The platform owns the conversation; Gmail is a window onto it.** No OAuth
into anybody's mailbox. Every email a conversation sends carries a signed
Reply-To, `t+<threadId>.<hmac>@MAIL_INBOUND_DOMAIN`; Resend Inbound posts the
answer to `/api/mail/inbound` (Svix-signed) and it lands in the same thread.
Each agency also has `<slug>@MAIL_INBOUND_DOMAIN`, an admin-only mailbox.

- **Data:** `mail_thread` (one per lead, made by a trigger on `lead` insert,
  backfilled), `mail_message`, `mail_read` (per-person unread). Status and
  assignee stay on `lead`. RLS on, SELECT-only. `user.verified_email` (0017).
- **Permissions:** `mail:read` = `lead:read`, `mail:send` = `lead:update`, an
  offer's thread also needs `lead:read_offer`, agency-address mail is
  `lead:read_all` only. Non-admins narrowed in SQL, as the lead inbox.
- **Sending:** recorded `queued` in a tx, sent after it, marked `sent`/`failed`
  with a retry. An agent answering a notice from Gmail is RELAYED to the buyer
  only when DMARC passed and can() lets them send; otherwise held with a reason.
- **Console:** `/inbox` (agency) and `/my-inbox` (agent) — folders, unread,
  reader with status/assignee pickers, composer, sandboxed original HTML (no
  remote fetches). Nav badges. "Open conversation" on every lead row.
- **Website:** `/account/messages` (+ `/[id]`). Email-matched threads show only
  after the account proves its address via an emailed link (`/verify`, POST to
  confirm) — sign-up here does not confirm emails, so the address alone would
  let anyone read someone else's agency mail. Alert emails stay on `/alerts`.
- **Off until configured:** with `MAIL_INBOUND_DOMAIN` + `MAIL_REPLY_SECRET`
  unset, console replies still send and replies go to the agent's own email.
  Setup steps: `docs/DEPLOY.md` → "Email conversations — one-time setup".

## What M5 added

Four pieces, built in order, each verified before the next started.

**A sale can be recorded at all.** `listing_status` already had `'sold'` and
`sold_price` / `sold_date` already existed, but `setListingStatus` narrowed its
transition union to exclude `'sold'` and no zod schema mentioned the columns —
so only the seed had ever written a sale. `setListingStatus` now accepts it,
carrying `soldDetailsSchema`, under a new `listing:sell` permission. The console
has a "Mark sold" dialog and an "Under offer" control, neither of which existed.

**History follows the property, on every page (ADR 0013, amending 0012).**
The client reversed "hide history while on the market": `/listing/[id]` now
renders the Timeline and a Property history tab whenever the address has an
earlier entry. `upsertProperty` matches on `addressKey` (case, spacing,
St/Street-style abbreviations, unit prefixes, "32/6E" in the number box) under
a transaction-scoped advisory lock, so a second agency re-listing an address
joins the existing property. A live address sends `/property/<id>`, an old
`/listing/<sold id>` bookmark and `/sold` cards to the live listing ("For sale
now"); off-market, the bookmark goes to `/property/<id>`. Drafts never redirect.
Joining an existing property writes only the physical facts the new ad states
(`providedPhysicalFields`); blanks clear a field only when an agent edits the
property their own listing already stands on.

**`/property/[id]`** — the first public route keyed by a property. Renders only
when nothing at the address is on the market AND something there was once
public; `noindex`; reachable by direct link only. Carries the sale history in
the portal-standard vertical timeline (year · Sold · price · "Sold <date> by
<agency>" · thumbnail).

**A private offer** goes to the agency that last sold the address, as a `lead`
row and an email. `lead` is now anchored to `property_id` (NOT NULL) with a
nullable `listing_id`. Sign-in required — the first code to populate
`lead.user_id`.

**The guide can see sales.** New `recent_sales` tool + prompt v9. Asked "what
has sold in Pakenham within 30km", a live model now calls it and answers with
the exact price, date and distance, and says the sale is not something to buy.

**Approval and agent lead privacy (ADR 0014, 2026-10-02).** Agents no longer
publish: `listing:publish` is owner/admin only, and the new `listing:submit`
(admin or named agent) moves a draft/withdrawn listing to `pending` ("Pending
approval"). The agency table offers "Approve & publish" / "Send back"; the agent
table "Submit for approval" / "Cancel submission"; both headers count
"Awaiting approval". Leads: `lead:read_all` (admins) is the whole agency;
anybody else's inbox is narrowed in SQL to leads assigned to them or from a
listing they are named on (unassigned included), and such an agent may work an
unassigned one. The agent desk's Leads link is live at `/my-leads`. Known gap:
an agent editing a LIVE listing still changes the public ad without review.

**Lead triage (2026-10-02).** `/leads` now moves leads: a status picker
(new / contacted / qualified / closed, any direction) and an assignee picker.
`lead:update` — an admin, or the member the lead is assigned to (resource
`ownerId`); `lead:assign` — admins. On an offer both also need
`lead:read_offer`, and an offer cannot be assigned to someone who cannot read
it. `updateLeadStatus` guards on the assignment it decided on (a reassignment
in between is a `conflict`); `assignLead` repeats the active-membership check
inside the UPDATE. Another agency's lead id is `not_found`.

**The lead inbox.** `/leads` was an `AgencyPlaceholder`; it now reads the `lead`
table. Enquiries and private offers share one screen with tabs, because they
share a row and every lead is anchored to a property — but offers are rare and
high-value and would be buried in a date-sorted list, so the tabs plus a nav
badge are what stop the feature failing quietly. Two permissions, not one:
`lead:read` opens the inbox for any active member; `lead:read_offer` is
owner/admin only and becomes a WHERE clause, so a non-admin sees an inbox in
which offers never existed rather than one saying three are hidden.

## Decisions worth not relitigating

- `listing_status` is the single lifecycle authority; `channel` stays what the
  ad sells. The `'sold'`/`'leased'` channel values are legacy — docs/adr/0012.
- An offer hangs off the property, never the historic sold listing:
  `lead.listing_id` is `ON DELETE CASCADE` and `setListingStatus` accepts
  `'withdrawn'` from any status, so an agency could withdraw a sold listing,
  clear `UNDELETABLE`, delete it, and silently cascade away every offer.
- `EmailMessage` is now `marketing | transactional`. Transactional carries no
  one-click unsubscribe, because that header promises an unauthenticated POST
  endpoint and inventing one would ship a way to silently switch an agency's
  offer notifications off.
- Sold data is NOT in the public search surface. `PUBLIC_STATUS` stays `'live'`
  at all 8 filter sites, so the alerts scheduler and email digests are
  unchanged. The guide reaches sold data through its own tool.

## Numbers as of this entry (2026-10-06, Phase 3b)

- `pnpm typecheck` and `pnpm lint` clean; `pnpm build` 2/2.
- `pnpm test` 709 (@repo/core) + 270 (@repo/ai), all offline and free.
- `pnpm smoke` 159 passed, 1 failed, 14 skipped. The failure is the known dev
  auth account with no public.user row (not this work). The 5 new Google/Zoom
  checks pass, each break-checked red in a separate worktree.
- A run started while the dev server was recompiling skips the web HTTP checks
  ("web app is not running"); re-run once it answers.

## Open / next

- **To make replies come back:** set `MAIL_INBOUND_DOMAIN` to Resend's
  `<id>.resend.app` receiving domain (Emails → Receiving → ⋯) and
  `MAIL_REPLY_SECRET`; restart. Pulling works on localhost — no webhook needed.

- **One browser = one account across web, agency and agents** (shared
  `.lvh.me` cookie, ADR 0003). Signing in on the website as a buyer signs the
  console out of the agency account, and the reverse. Test the buyer side in a
  private window or another browser.

- **To switch inbound on:** Resend receiving subdomain + MX, webhook to
  `/api/mail/inbound` (`email.received`), then `MAIL_INBOUND_DOMAIN`,
  `MAIL_REPLY_SECRET`, `RESEND_WEBHOOK_SECRET`. Then TEST-PLAN M1–M13.
- **Not built (ADR 0016 "Not done"):** attachments are listed, not stored or
  sent; no rich-text composer or signature; buyers reply by email, not on the
  site; no realtime — the inbox refreshes on navigation and after actions.
- **Private-offer notice** (web `offer-action.ts`) does not carry the thread's
  Reply-To yet; offers are answered from `/inbox`.
- **Dev data:** property `e99d1a30` (32/6E Henry Street) still has the
  overwritten land/pin/address from the 2026-10-02 relist test.
- **Dev DB pool:** `.env.local` DATABASE_URL is the transaction pooler (:6543);
  DIRECT_URL the session pooler for migrations.
- **Next on leads/listings:** an open/closed filter; telling admins a listing
  is waiting; review of edits to live listings (ADR 0014 "Not done").
- `apps/web` and `apps/console` were written by Claude Code at the user's
  explicit request, against the tool split in CLAUDE.md.
