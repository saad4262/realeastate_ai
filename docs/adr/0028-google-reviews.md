# 0028 — Google Reviews

**Status:** ACCEPTED, 2026-10-06. **Step 1 built** 2026-10-06 (Phase 5, migration 0033) — see "As built"; step 2 (Business Profile, Link to contact) not built. **Supersedes ADR 0023** (its client decisions stand; this adds the design and settles where the place comes from). Decisions at the end ("Decided").

**Context.** The agency's Google rating and reviews should show in the console and on the
public agency and agent profiles. Reviews belong to the business. Google offers two sources:
the **Places API** (any business's public rating, review count and a few recent reviews, with
our existing server key) and the **Business Profile API** (all of the agency's own reviews,
with replies, but only for the profile's owner, through OAuth, after Google approves API
access).

## Decision

1. **Business-level only (0023 §3).** Reviews belong to the agency. An agent's public and
   console profile shows **the agency's** reviews and rating, labelled as the agency's. Nothing
   ever attributes a review to an agent.
2. **One Google listing per agency, picked by search.** An owner/admin opens Settings →
   Google reviews → **Find our Google listing**, types the agency's name and suburb, and the
   server runs a Places Text Search with `GOOGLE_MAPS_API_KEY` (the browser never holds the
   server key), showing name, address and rating for each result. They pick one; we store its
   **place id** (Google allows storing place ids indefinitely). Table `agency_google_place`:
   agency_id (unique for now; a table so more listings are possible later), place_id, name and
   formatted address as shown at pick time, picked_by, picked_at. Changing it is the same picker.
3. **Step 1 — Places API (Place Details, reviews field).** Rating, total count and the handful
   of reviews the API returns (it returns a few, chosen by Google, not all). **Storage follows
   the Google Maps Platform terms**, which restrict caching Places content: we store the place
   id; the rating/count/reviews are held in a short-lived server cache only (one Details call
   per agency per refresh window, open question 1) and **always displayed with Google's
   attribution** and the review authors' attribution as the terms require. Confirm the current
   terms before building. Because Places content cannot be kept, **step 1 has no "Link to
   contact"** — there is nothing durable to link (open question 2).
4. **Step 2 — Business Profile API** (provider `google_reviews`, agency-level, connected by an
   owner/admin through ADR 0020's flow; scope `business.manage`, a sensitive scope → Google
   verification, plus Google's separate approval for Business Profile API access). We list the
   locations the connected account manages, the admin confirms the one matching the picked
   place, and a daily cron sync (plus a **Refresh** button) stores the agency's own reviews:
   table `google_review` — agency_id, external review id (unique per agency), star rating,
   comment, reviewer display name, create/update time, the agency's reply if any, fetched_at,
   **contact_id (null)**, linked_by, linked_at. Removed upstream → marked removed, not shown.
5. **Linking to a contact is manual (0023 §4).** Only an owner/admin, on a stored (step 2)
   review, presses **Link to contact** and picks the person from the directory. Never matched
   automatically on a name. Unlinked reviews show **Unmatched**. A linked review shows on that
   contact's Reviews tab and timeline (`activity` `review_linked`), and can be unlinked.
6. **Review requests** stay as 0023 §5 decided: an email with preview + explicit Approve, inside
   the sending limits, no incentives, no gating. That is its own small build after step 2.

## Caching and rate limits

- **Places (step 1):** one Place Details request per agency per refresh window from the cron
  tick — never one per page view; pages read the server cache. The public website is
  ISR-cached on top. Places is billed per request: ~100 agencies × a few refreshes a day is a
  small, predictable number. On a Google error we keep showing the last cached figures with
  "as of <time>" until the cache window passes, then hide the section rather than show stale
  numbers indefinitely.
- **Business Profile (step 2):** daily sync per agency plus on-demand Refresh limited to once
  per 10 minutes per agency; well inside Google's default per-project quota. Push
  notifications (Pub/Sub) need a public domain — later, if daily is not fresh enough.
- The picker's Text Search: debounced, server-side, at most one request per second per admin.

## Permissions (all through `can()`)

- `google_place:manage` — pick or change the agency's listing: owner/admin.
- `integration:manage` (exists) — connect `google_reviews` (agency-level): owner/admin.
- `review:read` — see reviews in the console: any active member of the agency.
- `review:link` — Link / Unlink to a contact: owner/admin; the contact must also pass
  `contact:read` for them.
- A linked review on a contact's tab is visible to whoever may read the contact (`contact:read`).
- Public pages show only what Google shows publicly (rating, count, the reviews returned).

## When reviews are not connected

- **No place picked:** admins see "Show your Google rating — find your agency's Google listing"
  with the picker; agents see "Your agency hasn't connected its Google reviews yet"; the
  **public** agency and agent pages show **nothing** (no empty box, no zero stars).
- **Place picked, Business Profile not connected:** step 1 content shows; the Reviews screen
  says "Showing the few reviews Google makes public. Connect Google Business Profile to see all
  reviews and link them to contacts" with **Connect Google Reviews first** for admins.
- **Connection expired:** stored reviews still show with "as of <date>"; admins see
  "Reconnect".
- **The assistant** (later): a `find_reviews` read tool answers "Connect Google Reviews first"
  with the link when step 2 is not connected; it never links a review to a contact itself —
  that would be a proposed action with a card, and only an admin may approve it.

## Failure cases

| Case | What happens |
|---|---|
| The agency picks the wrong listing | Change it in Settings; cached Places content is dropped; stored step-2 reviews belong to the previous location and are hidden until re-synced. |
| Place closed or id changed by Google | Details returns NOT_FOUND → admins asked to pick again; public pages hide the section. |
| Google API key over quota / billing off | Last good cache shown "as of", then hidden; an admin notice. |
| Business Profile access not yet approved by Google | Connect shows "Google hasn't approved Business Profile access for this app yet"; step 1 keeps working. |
| Review deleted upstream after linking | Marked removed; the contact's tab says "This review was removed from Google". |
| Two admins link the same review to different contacts | The link is one column with a guarded update; the second sees "already linked to …". |

## Tests to write

- Unit: picker results never expose the server key; attribution present in every render
  component; place id is the only Places field persisted (a test greps the write paths).
- Unit: step-2 sync upserts by external id, marks removed, never touches `contact_id`.
- Smoke (fake Google, rolled back): agency A's reviews never appear for agency B; an agent
  cannot link; linking needs `contact:read` on the contact; a linked review appears on the
  contact's tab and timeline; public page hides the section with no place picked; Places
  failure shows cached "as of" then hides.
- Permission tests for `google_place:manage`, `review:read`, `review:link`.
- **Break-tests:** auto-match on name → red; store Places review text → red; drop the agency
  filter → red; show an empty widget publicly when not connected → red.

## Open questions (recommended answer first)

1. **Places refresh window** — *every 6 hours, held only in the server cache*, subject to
   the current Google Maps Platform terms.
2. **"Link to contact" in step 1?** — *No; linking starts with step 2*, because Places review
   content may not be stored.
3. **Show reviews on the public agent profile?** — *Yes, the agency's, labelled "Reviews of
   <Agency>"*, never as the agent's.
4. **Reply to reviews from the console (step 2 allows it)?** — *Not yet*; read and link first.
5. **Hide low-star reviews?** — *Never*; showing a filtered set misleads (ACCC) and Google's
   terms require showing what it returns as returned.
6. **Several offices/listings per agency?** — *One for now*; the table allows more later.

## Decided (2026-10-06)

- **Q6 (client): one Google listing per agency for now; several offices in version 2.**
  `agency_google_place` stays a table (unique on agency for now) so v2 only drops the
  uniqueness.
- Q1–Q5: **accepted as recommended** (Places refresh every 6 h in the server cache only;
  linking starts with step 2; the agency's reviews on agent profiles, labelled as the agency's;
  no replying from the console yet; low-star reviews never hidden).

## As built — step 1 (Phase 5, 2026-10-06)

**Google's terms were checked before building** (Places API policies page and the Maps
Platform service terms, 2026-10-06). They say:
- The **place id** may be stored indefinitely. No other Places content may be pre-fetched,
  cached or stored; only latitude/longitude may be cached, for up to 30 days.
- Places content shown without a Google map carries Google's attribution (the logo, or the
  text "Google Maps" where space is short).
- Every review credits its author (name, photo, profile link) and links to the review on
  Google Maps.
- How reviews are chosen and ordered must be stated.

Where this build differs from the decision above, **the terms win**:
- **No cache.** The 6-hour server cache (decided Q1) is not built. Rating and reviews are
  fetched from Google each time they are shown, and dropped after. Identical requests in
  flight at the same instant share one call; nothing outlives the answer. **Cost:** one
  Place Details call (with reviews) per view. To keep that down, the public section loads
  only when a visitor scrolls near it. It is capped at 20 per minute per IP and 120 Google
  calls per minute per server instance; past a cap, the section just doesn't show.
- **`agency_google_place` stores only the place id** (and who picked it, when). It does not
  store the name and address "as shown at pick time" from §2: those are Places content. The
  console shows them live. A unit test fails if the table gains any other column.
- **Public pages:** this platform has no public agency or agent profile pages yet. The
  agency's rating and reviews show on each **live listing's page**, labelled "Reviews of
  <Agency>". A browser component fetches them from `/api/reviews/<listingId>` (no-store,
  rate-limited), so Google content never enters the ISR-cached HTML. It renders **nothing**
  when the listing isn't live, nothing is picked, the place is gone, or Google doesn't answer.
- **Console:** Settings → Google reviews (owner/admin: picker, change, remove) and **Agency
  reviews** in the agent menu (every member, read-only).
- **Attribution** lives in one component, `@repo/ui/google-reviews`. It uses the text form
  "Google Maps"; **swap in Google's official logo asset before go-live** (design/legal). A
  static test fails if attribution, author links, review links or the notice go missing, if
  reviews are filtered/sorted/sliced, or if either app renders a review itself.
- **"Link to contact" is not built in step 1** (ADR decision 3, Q2): Places review text may
  not be stored, so there is nothing durable to link. It arrives with step 2.
- Picker search: server-side, owner/admin, at most one search a second per person; a picked
  id is confirmed with Google (outside any transaction) before it is stored.
