# Status
- Milestone: **M6 — email conversations live in the app (ADR 0016).** Every lead
  is a conversation an agency can read and answer in the console; buyers read
  theirs on the website; replies from Gmail land back in the same thread.
  Built on M5 (sold properties, private offers, the lead inbox).
- **Now: CRM Phase 2 (Contact 360) done on `feat/crm`, waiting for review.**
  Plan: `~/.claude/plans/pasted-content-id-f0ff-you-are-functional-frost.md`.
  Next: Phase 3 (appointments, then Zoom / Google Calendar) — not started.
- Build order (locked): Agency UI → Agent UI → Consumer web
- Last tool: Claude Code
- Last updated: 2026-10-05
- Deploying: `apps/web` only, Vercel Hobby. `apps/console` waits for a real
  domain — see `docs/DEPLOY.md`. **Nothing is deployed yet.**

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

## Numbers as of this entry

- `pnpm typecheck` 10/10, `pnpm lint` 0 errors (1 old `<img>` warning),
  `pnpm build` 2/2 — `/inbox` 137 B / 124 kB first load
- `pnpm test` 588 (@repo/core) + 263 (@repo/ai), all offline and free
- `pnpm smoke` 119 passed, 4 failed, 14 skipped. The 6 new email checks pass,
  each break-checked red. **The 4 failures are the cache-speed checks** (home,
  suburb, radius, "fast the second time"): the long-running dev server on :3000
  now needs two requests after a revalidate before it serves from cache. A
  fresh `next dev` on another port, with this code, measured cold ~430 ms →
  warm ~40 ms, and the same server failed identically with the change stashed —
  so: restart the dev servers and re-run before reading anything into them.
- Migrations 0016 and 0017 are applied to the dev database; no drift.
- TEST-PLAN section M: M3 + M6 verified for real (2026-10-03); the rest not
  yet clicked through.

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
