# 0075 — One address, several agencies: no agency rewrites another's property, and each gets its own deal

**Status:** accepted, 2026-10-31 — the user chose option A. Built on `feat/property-per-agency`. Migration
0075 (additive: listing facts + backfill + the per-agency deal index) APPLIED 2026-10-31 at the user's go (76
recorded; 41 listings backfilled). Code deployed as `206f30c` (the user verified web and console live, no sync
errors). 0076 (drops the old index) APPLIED 2026-10-31 at the user's go after a rolled-back dry run (twice;
two agencies' open deals on one address allowed, a second open deal of one agency refused) — 77 recorded.

**Context.** `property` is one row per address, shared by every agency (non-negotiable 1: property ≠ listing;
the address keeps its history across campaigns and agencies). Two flaws found 2026-10-31 while seeding:
1. **A listing rewrites the shared row.** `upsertProperty` (create and edit listing) writes the caller's pin
   ("a carried pin always wins", and a manual one clears `place_id` / `formatted_address`) and its physical
   facts (type, bedrooms, bathrooms, car spaces) into the existing row — for every agency that uses it. Seen:
   a test listing rewrote agency Alpha's 27 Lakeside Blvd. About 40 places read those facts (public search,
   listing and sold pages, matching, recent sales, dashboards, the assistant).
2. **One open deal per address across all agencies.** `deal_open_property_idx` is unique on `property_id`
   where open, and the sync's `on conflict (property_id) … do nothing` drops the second agency silently: no
   deal, no Pipeline card, no Finance figures. In Australia one home is often listed by several agencies.
Today: 40 properties, none used by two agencies (Lakeside was moved) — the right moment to change it.

**Decision — part 1 (deals, no choice needed).** The open-deal index becomes unique on
`(agency_id, property_id)` where open; the sync's conflicts and its "no deal yet on this address" checks
name the agency. Every deal read is already agency-scoped (`visibleDealsSql`, `agency_id`), so no agency
ever sees another's deal.

**Decision — part 2 (the facts and the pin), options for the user:**
- **A. CHOSEN — the facts as advertised live on the listing.** `listing` gets `property_type`,
  `bedrooms`, `bathrooms`, `car_spaces`; the form writes them there. Public pages, search, matching and
  the assistant read the listing's facts (falling back to the property's). The shared row is only ever
  filled where it is empty — the first pin, the first facts — never overwritten by a listing; a manual pin
  moves it only when no other agency uses the address. Correct for open listings (each agency's ad says
  what it says) and keeps the address's shared history. Larger: the ~40 readers change, one data copy.
- **B. Smaller — first come, first kept.** No new columns. An agency may write the shared row's facts and
  pin only while no other agency uses the address; otherwise its form shows them read-only ("on the
  address record, set by another agency"). Stops the damage in hours, but a second agency cannot correct
  its own ad's bedrooms.
- **C. Rejected — a property row per agency.** Breaks the address's history across agencies, recent
  sales and the public property page (non-negotiable 1's reason for a shared row).

**As built (A).** `listing` has the seven facts (type, bedrooms, bathrooms, car spaces, land, building, year
built); create and edit write the form's facts there (blanks clear them — the agent's own ad). `upsertProperty`
never overwrites an existing address: a fact is only filled where the address has none (`coalesce`), and a pin
moves only when the address has none, or the saving agency carries one and nobody else uses the address
(`usedByAnotherAgency`: a listing, deal, appointment, lead or contact link of another agency). Every read goes
through `listings/facts.ts` — `coalesce(listing.x, property.x)` — or, where there is no single listing, the
agency's newest ad at the address (property page, Properties list) or the newest ad at all (the public
off-market page). Lead datasets join the enquiry's listing. The deal sync is per agency throughout
(`distinct on (agency_id, property_id)`, `on conflict (agency_id, property_id)`).

**Checks.** Unit: `listings/facts.test.ts` — every fact reads the listing first; a source scan finds no read
of a fact straight off `property` in core; every deal insert conflicts on `(agency_id, property_id)` (both
break-tested red then green); `address-key.test.ts` — an existing fact only filled, a pin another agency
uses never moved. Real DB, rolled back: 0075 + 0076 twice, backfill complete (41 listings), and two agencies
on one made-up address — the second agency's create and its edit with a dragged pin leave the first one's
facts and pin alone, each form shows its own ad, each agency gets its own open deal. Smoke: the same, in
"Tenant isolation" (written, not run).

**Deploy order.** 1) apply 0075 (old code keeps working: it never reads the new columns, and the old index
is still there for its ON CONFLICT); 2) merge and deploy this code (needs 0075: it reads the listing's facts
and names the new index); 3) only then add and apply 0076, which drops the old index — at once: until then, if a
second agency lists an address that already has another agency's open deal, the sync's insert hits the old
index and that whole sync statement fails each minute (no such address exists today).
