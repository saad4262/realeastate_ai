# Status
- Milestone: **M5 — sold properties are first-class, and the lead inbox is
  real.** An agency can record a sale; an off-market address has its own public
  page carrying its sale history; a signed-in visitor can make a private offer
  on one; the AI guide can answer what has sold; and `/leads` is a working
  inbox rather than a placeholder.
- Build order (locked): Agency UI → Agent UI → Consumer web
- Last tool: Claude Code
- Last updated: 2026-10-02
- Deploying: `apps/web` only, Vercel Hobby. `apps/console` waits for a real
  domain — see `docs/DEPLOY.md`. **Nothing is deployed yet.**

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

- `pnpm typecheck` 10/10, `pnpm build` 2/2
- `pnpm test` 518 (@repo/core) + 260 (@repo/ai), all offline and free
- `pnpm smoke` 111 passed, 0 failed, 14 skipped — fully green. The two
  long-standing failures were stale checks: the chat one asked for a "History"
  label the UI pass replaced with a conversations rail, and the cron one read
  vercel.json's daily Hobby floor instead of the GitHub Actions tick.
- `pnpm smoke:ai` run once deliberately (~US$0.02): the new
  `the guide reaches for sold data instead of denying it exists` check passed
- Migration `0014_lead_property_offers` is applied to the dev database;
  `pnpm db:generate` afterwards reports no drift

## Open / next

- **Dev data:** the 2026-10-02 relist E2E did exactly that to property
  `e99d1a30` (32/6E Henry Street): land 322 m², pin -38.076151/145.483831 and
  formatted_address were overwritten and are not yet restored (the DB write was
  not permitted in-session).
- **Dev DB pool:** `.env.local` DATABASE_URL now uses the transaction pooler
  (:6543); DIRECT_URL stays on the session pooler for migrations. Running dev
  servers keep their old pool until restarted.
- **Triage smoke on dev data:** the dev DB holds only offers, so the tenancy
  half of the triage smoke check cannot be isolated there (it says so in its
  output); the unit test covers it and was break-checked.
- **Next on leads:** the agent desk's Leads link (now that assignment gives an
  agent "their" leads), and an open/closed filter on the inbox.
- **The agent desk's Leads link is still `href: '#'`.** Agents now hold
  `lead:read`, so the screen would work for them; what is undecided is scoping —
  an agent should probably see leads on listings they are named on, or ones
  assigned to them, not the whole agency book.
- `apps/web` and `apps/console` were written by Claude Code this session at the
  user's explicit request, against the tool split in CLAUDE.md.
- The two pre-existing smoke failures are untouched and unrelated.
