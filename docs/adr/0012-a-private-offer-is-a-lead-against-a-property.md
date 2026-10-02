# 0012 — A private offer is a lead against a property, not a listing

**Status:** accepted, 2026-09-30. Depends on ADR 0001 (Drizzle owns the schema)
and on non-negotiable #1 (property !== listing).

**Context.** Two requirements arrived together: hide a property's past sale
prices while it is on the market, and let a signed-in visitor make a private
offer on one that is off-market, routed to the agency that last sold it. Neither
is buildable on what exists. `listing_status` already has `'sold'` and
`listing.sold_price` / `sold_date` already exist, but `setListingStatus` narrows
its transition union to exclude `'sold'` and no zod schema mentions the columns,
so only the seed has ever recorded a sale. And `/listing/[id]` renders only for
`status = 'live'`, so "hide history while on market" removes the timeline from
the one page that has it — while no public route is keyed by a property at all.

**Decision, four parts.**

1. **`listing_status` is the single authority on where a listing is in its
   life.** `listing_channel` stays what the ad is selling — `sale` or `rent`.
   The `'sold'` and `'leased'` channel values are legacy and nothing new writes
   them; a sold sale listing is `channel: 'sale', status: 'sold'`. Two columns
   encoding the same fact with no reconciliation is how a listing ends up sold
   on one axis and for sale on the other.

2. **History is hidden while the property is on the market**, where on-market is
   `ON_MARKET_STATUSES = ['live', 'under_offer']` — deliberately broader than
   `PUBLIC_STATUS`. An `under_offer` listing has no public page, so keying this
   on `'live'` alone would make a property mid-transaction read as off-market:
   its previous sale price published, and a private offer button pointed at the
   agency currently selling it. `pending` is in neither list, so a pending-only
   property is not reachable and blocks nothing.

3. **`lead` is anchored to a property.** `property_id` is `NOT NULL` (backfilled
   through `listing`, total because `listing_id` was `NOT NULL` and every
   listing has a property) and `listing_id` becomes nullable — "which ad brought
   this in, if an ad did". The alternative, hanging an offer off the historic
   sold listing, is unsafe: `lead.listing_id` is `ON DELETE CASCADE` and
   `setListingStatus` accepts `'withdrawn'` from any status with no from-guard,
   so an agency could withdraw a sold listing, clear `UNDELETABLE`, delete it,
   and silently cascade away every offer ever made on that address.

4. **An offer requires sign-in**, and its email address comes from the session
   rather than the form. This is the first code to populate `lead.user_id`. An
   anonymous financial approach to a private owner is not attributable to
   anyone, and the enquiry form's IP limiter is a ceiling on accidental volume,
   not identity.

**Why not a separate `private_offer` table.** All the triage machinery —
`status`, `assigned_to`, `ai_summary`, `ai_intent`, `ai_qualification` — is on
`lead`, and the console has one inbox. A second table duplicates it, needs its
own hand-written RLS policy, and makes every future inbox read a UNION.
`lead_kind` is the extension point that was built for this.

**Consequences.** `createEnquiry` now selects and writes `property_id` too, so
an enquiry and an offer land in the same per-address inbox. `lead` gains indexes
on `(agency_id, created_at)` and `property_id`, and `listing.property_id` gains
the index Postgres never creates for a foreign key — `propertyTimeline` has been
filtering on it unindexed on every listing page render. `EmailMessage` splits
into a `marketing` / `transactional` union so an agency notification can omit
the one-click unsubscribe header that a bulk digest must carry; the bulk builder's
return type narrows to `MarketingMessage`, which is what keeps the existing
Spam Act guards in force. Nothing widens the public search surface:
`PUBLIC_STATUS` stays `'live'` everywhere, so the alerts scheduler and the email
digests see exactly what they saw before.
