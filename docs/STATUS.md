# Status
- Milestone: **M4 started** — consumer accounts and the AI task scheduler;
  consumer AI property guide at `/chat`; listings full CRUD; PostGIS radius search
- Build order (locked): Agency UI → Agent UI → Consumer web
- Last tool: Cursor
- Last updated: 2026-09-26

## Chat history is a screen, and opening one stays open (2026-09-26)

History was a dropdown drawn over the hero, so the headline showed through
the one saved chat and there was no real way to open it. It is now
`/chat?history=1`: a list, each row an **Open** link to `/chat?thread=…`.

Opening one used to change the URL and leave the empty hero on screen.
`ChatView` keeps the transcript in `useState`, and a client navigation does
not remount it, so the new turns were ignored. The view is keyed on the
thread id. A reload of that URL opens the same chat; the sidebar brief is
restored from the last saved search. Delete returns to the history screen.

## The AI task scheduler is built (2026-09-26)

A saved search that runs on a clock and arrives unasked — by email with a
summary and a link, and in the app at `/alerts` and on a `/chat` card. Full
account in `docs/SESSION.md`; the decisions are ADR **0010** (a schedule
stores a frozen query, not a prompt to re-interpret) and ADR **0011** (a
consumer is an actor with no agency).

**Consumer accounts exist.** `apps/web` has email/password sign-up and sign-in
with a name, plus forgot/reset,
and a middleware matcher that covers account routes only — `/`, `/search` and
`/listing/[id]` stay outside it and keep their 33/36/32 ms. `/` is still a
static ISR route.

**The run path calls no model.** The browser hands over the `/search?…` path,
the server re-parses it with the same vocabulary `/search` uses, and each run
is pure SQL plus one cheap Haiku call for two sentences of prose. That call
is skipped when the durable spend budget says so, and the alert still goes
out with a templated sentence.

**Email is real.** `packages/core/src/email/` — a port, a fake for tests, a
Resend adapter over plain `fetch`, and a digest that **throws** rather than
building a message with no sender identity or no unsubscribe.

**Scheduling is conversational.** There is no save button in the chat. The
visitor asks — "send me this daily", "every two hours" — the guide calls
`draft_schedule`, and a confirmation card appears in the conversation with
Accept and Cancel. Nothing is written until Accept: the draft travels as an
HMAC-signed token, so the browser cannot change the search or the frequency
it is agreeing to. `cancel_schedule` pauses rather than deletes, and asks
which when more than one matches. Cadence is `daily`, `weekly` or
`interval` (10 minutes and up, with no ceiling — a fortnight and a quarter are
both expressible); the `/search` page keeps its own save
button for people who never open the chat. Conversations are saved for a signed-in visitor
(`chat_thread` + `chat_message`), with a sidebar, delete, and a 90-day
retention sweep on the scheduler tick. A replayed thread carries no prices:
`toModelTurns` returns only what `chatRequestSchema` already accepts from a
browser.

### Current numbers
- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **554** (378 `@repo/core`, 176 `@repo/ai`)
- `pnpm smoke` — **0 failed** (76 with the console down)
- Web routes: `/` 459 B / 131 kB (ISR 30s) · `/login` 161 B / 106 kB ·
  `/alerts` 1.44 kB / 108 kB · `/search` 3.78 kB / 134 kB · `/chat` 9.89 kB / 121 kB

### What still needs a person
- ~~A verified Resend domain~~ **Done, and the send path is proven.**
  `quotemydecking.com.au` is `status: verified`, `sending: enabled`, and
  `ALERT_EMAIL_FROM` is `alerts@quotemydecking.com.au`. A real digest built
  from live rows was accepted by Resend on 2026-09-28 (to
  `delivered@resend.dev`, their simulator, so no person was emailed).
  `requireSenderIdentity` now also refuses a value that is not an address —
  the bare domain was set here for two days and every send failed validation.
- **The sender identity is dummy data.** `ALERT_SENDER_NAME="Test Company"`
  and `ALERT_SENDER_ADDRESS="123 Test St, Test City"` are in `.env.local` for
  testing. The Spam Act requires a real legal entity and a real postal
  address before any message goes to a real person.
- **`ALERT_UNSUBSCRIBE_SECRET` and `CRON_SECRET` are dev placeholders.** Both
  need real values in any deployment; unset means the endpoint refuses
  everything with 503, which is the intended failure.
- **Every run emails, including one that found nothing new.** Changed on
  request 2026-09-28. A run still records `status: 'empty'` when the search
  turns up nothing new — that is what the search found — but the digest goes
  out regardless, subjected "No new listings — …". `/alerts` therefore lists
  runs by `email_status = 'sent'` rather than by status.
  **Watch the deliverability.** A recurring no-change message is the fastest
  way to train somebody to mark a sender as spam, and enough complaints take
  the sending domain down for the digests that do carry news. Lawful (the
  recipient created the schedule, and every message carries sender identity,
  postal address and one-click unsubscribe); still worth watching the Resend
  bounce and complaint rates once real recipients exist.
- **Vercel Hobby only runs crons daily.** `apps/web/vercel.json` declares
  `*/5 * * * *`, which needs Pro — or any external pinger, since the
  endpoint authorises a shared secret and does not care who calls it. See
  `apps/web/CRON.md`. **Nothing ticks it on localhost**, which is the whole
  reason a saved schedule appears to do nothing in development: run it by
  hand with the curl in `CRON.md`.
- **Manual cases are `docs/TEST-PLAN.md` § I.** Nothing in them has been run
  by a person yet; everything checkable without a browser and an inbox is in
  `pnpm smoke`.

## The chat hands over a search, and both public pages become a portal (2026-09-24, phases 1–8)

Eight commits. The ask was: after the AI answers a prompt, give a link built
**from that prompt** that opens a listing page in a new tab, and from there a
property page — both looking like a real estate portal. Full account in
`docs/SESSION.md`; the standing rules are in **`ARCHITECTURE.md`**.

**The link existed all along.** `searchQueryToPath` has built a per-prompt
`/search?…` since the chat shipped, and the only way to it was a small text
line in a sidebar that is behind a tab on mobile. Worse, the server sends
**two** links and the client threw one away: `case 'state':` did `setSlots()`
and dropped `event.deepLink` — the turn-level link built from the accumulated
brief, and the only link a turn has when the guide asks a question instead of
searching. Each assistant turn now hands over one link, in a new tab, with a
precedence that covers the too-broad case (the panel is empty on purpose, so
the link is the only route to matches the server already counted) and
deliberately gives none on a zero-match turn, which would be a button to an
empty page.

**Tailwind v4 in `apps/web` only, without preflight**, with `@theme static` so
the CSS Modules still styling most of the app read the same tokens as plain
custom properties. Token *structure* from the Stitch mock, *values* from this
site — its palette is cool slate and this site is warm, and taking it would
have left `/search` looking like a different product from `/chat`.

**Three queries that were always possible and never written**: inspection
times, the property's transaction history (genuinely derivable — a property
outlives its listings, and `sold_price`/`sold_date` are stored), and the agents
to call. All three now feed the listing page.

**Both public pages rebuilt.** `/listing/[id]` is a property page —
breadcrumbs, media frame, price-first header, 8/4 split with a sticky agent
panel — and it is *smaller* than the thin article it replaced. `/search` is a
results page rather than a hero with a list. The card got a media slot shaped
for a photo that does not exist yet, and a per-listing gradient hue so a page
of 24 does not read as 24 failed images.

**The enquiry form writes a real `lead`** — the first thing ever to insert into
that table. It is public and unauthenticated, so its whole authorisation story
is what the server decides rather than accepts: the browser picks a listing id
and nothing else.

### Four bugs found on the way, three of them the same bug

- **`unstable_cache` serialises to JSON**, so every `Date` through it comes back
  an ISO *string* while the type says `Date`. Nothing caught it for months
  because nothing rendered a date. That is the third shape of one bug here —
  bigint counts as strings, `numeric` as strings, now dates — and
  `ARCHITECTURE.md` § 6 now names the class and says to assert the *type*, not
  just the value.
- **Every price on the site was faux-bold.** Six rules set `font-weight: 700`
  and only 400 and 600 were loaded. Measured rather than assumed: these are
  variable fonts, so the fix cost **zero bytes**.
- **`--color-surface`** was referenced by three modules and defined nowhere.
- **A fourth junk field**: `description` was `"asd"` on a live listing, under
  the heading "About this property". Rule added, two rows repaired.

### Current numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **312** (220 `@repo/core`, 92 `@repo/ai`)
- `pnpm smoke` — **59 passed, 0 failed**
- Web routes: `/` 446 B / 125 kB · `/search` 1.66 kB / 126 kB ·
  `/listing/[id]` 2.64 kB / 109 kB · `/chat` 8.1 kB / 114 kB · shared 103 kB

### Still missing, deliberately

Detail and reasoning in `ARCHITECTURE.md` § 14. In short: **no photos anywhere**
(the `media` table exists, nothing populates it, and both media slots are shaped
for `next/image` so one drops in without either layout moving); the listing
page's features / energy rating / market insights / school sections have no data
source and render as one honest line each rather than invented figures; and
`/listing/<unknown-id>` still answers HTTP 200 — in dev as well as production,
which corrects an earlier note here.

## Performance & listing integrity (2026-09-24, Claude Code) — phases 1–13

Fourteen commits on `perf/phases-1-9`. Full account in `docs/SESSION.md`; the
standing rules all of this produced are now in **`ARCHITECTURE.md`**, which
`CLAUDE.md` points at and which should be read before adding a page, a query or
an endpoint.

**Speed.** Header/sidebar prefetch storm removed (12 full route prefetches per
console page load → 0). Server Actions read middleware's verified session
instead of re-running `getUser()` — **~520 ms off every publish, edit and
delete** (ADR 0008). Search-page waterfall unblocked. `staleTimes.dynamic`
0 → 30, tied to `cachedSearch`'s TTL. `loading.tsx` on the routes that query
the database, hover-intent prefetch on the results grid, maps lazy-loaded.
`/` is a cached route (`x-nextjs-cache: HIT`, `s-maxage=30`).

**The largest single win was not JavaScript.** Material Symbols was requested
across its whole variable axis space while every rule in the repo uses one
weight: **4,001,724 → 1,107,100 bytes (−2.9 MB, render-blocking)**. Fonts are
self-hosted via `next/font`; zero third-party font requests on the public site.

**Client JS.** Console shells → Server Components (layout chunk −50%), `/ai`
−64%, `/team` −38% (tab + selection moved into the URL), `/search` −29%,
`/listing/[id]` −26%. Search bar rewritten as a real GET form — eleven mirrored
`useState` gone, desync structurally impossible, and it works with JavaScript
off.

**A live impersonation hole, found and closed.** A forged `x-console-user-id`
rendered a real owner's agency console — HTTP 200, "Every listing in the agency
book" — through two paths that reached Server Components without
`updateSession` running. Middleware now strips those headers unconditionally,
before any branching. Proved with a live request, then proved fixed.

**Listing data integrity.** All three listings in this database were junk and
all three were live: headlines `"dfs"` / `"jdsfjdfjl"`, display prices of bare
digits, property types `"sfd"` / `"2jkads"`, one property claiming 23 bedrooms
and 32 bathrooms. Nothing was broken — every rule permitted it. Fixed at the
contract: headlines must be a phrase, a display price must read as price copy
rather than a naked number, room counts cap at 20, a sale listing must carry a
price, and **`property_type` is now a controlled vocabulary** — it was free
text, and the public search filter builds its dropdown from the distinct values
in that column, so buyers were being offered `"2jkads"` as a property type.
`pnpm smoke` now validates every live row against the real schema;
`pnpm db:repair-listings` fixes old rows, deriving from true data or writing an
honest NULL, never inventing a price.

**Console listings structure.** `listAgencyListings` had no LIMIT, because the
table's Live/Drafts figures were counted in the browser — so two header numbers
were forcing the whole agency book to be shipped on every page load. Counts are
window functions now (`count(*) filter (...) over()`, verified against the real
database), pagination is 25 a page through the URL, and it is still one query.

**Frontend review.** The concurrent Cursor redesign was reviewed and committed.
Two fixes: the new site header used raw `<a>` for every link — a full document
load on the most-clicked control on the site — and the map's "not pinned" tally
under-counted rows that had a latitude but no longitude.

### Current numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **277** (187 `@repo/core`, 90 `@repo/ai`)
- `pnpm smoke` — **55 passed, 0 failed**, 1 skipped, 3 notes
- Web routes: `/` 207 B / 124 kB (ISR 30s) · `/search` 1.67 kB / 126 kB ·
  `/listing/[id]` 2 kB / 108 kB · `/chat` 7.3 kB / 114 kB · shared 103 kB

### Deliberately left undone

Each with its reasoning in `ARCHITECTURE.md` § 14:

- `/listing/<unknown-id>` returns **HTTP 200** in production. Pre-existing, not
  caused by caching, and the only thing blocking ISR on that route — the
  caching itself was verified working end to end.
- `priceDisplay` is not cross-checked against `priceFrom`/`priceTo`; doing it
  means parsing the string, which #6 forbids in spirit.
- `router.refresh()` after a Server Action that already revalidated is probably
  a duplicate round trip, but removing it could not be verified without an
  authenticated console session.
- `useActionState` on the listing form — a convention change, not a speed one.

## Verified against the real model (2026-09-24)

`ANTHROPIC_API_KEY` is set and `/chat` has now run against Claude. Five things were wrong
that no unit test could see — full account in `docs/SESSION.md`:

- **`strict: true` made the guide invent filters.** It filled the *optional* fields on
  every call (`keywords: "-"`, `priceTo: 22`, `priceTo: 0`) on messages that mentioned
  neither, silently narrowing the search to nothing. Removed; zod re-parses every input
  anyway. It also 400s the request over `minimum`/`maximum`/`pattern`, so the JSON Schema
  now carries `type`, `enum` and `description` only
- **`length(2)` on an Australian state, a second time** — still in `slotsSchema`, so turn
  one worked and turn two 400'd for every VIC/NSW/QLD/TAS/ACT conversation. Now
  `auStateSchema` in both places (#8)
- **`effort: 'low'` was wrong** — choosing filters from a sentence IS the reasoning here.
  At low it sent `priceTo: 0`, missed "under 30km", and garbled one turn outright. Now
  `medium`, `max_tokens` 4096
- **The prompt asked instead of searching.** v2 enumerates the radius phrasings and
  assumes the channel with one disclosing clause. v1 kept beside it
- Working end to end: *"I need a house in Pakenham under 30km"* → `radiusKm: 30` applied
  unasked, link `…&suburb=Pakenham&radius=30` with no `lat=`, then asks for budget and
  bedrooms with results already on screen. A follow-up switches sale → rent and reads
  `$700` as weekly

**Demo data note:** one live listing (`3/10 Havana Parade, Pakenham`) has a junk price,
`9320334343324`, typed in during console testing. The guide flags it as a likely data
error rather than reading it out, which is correct — but it should be fixed or deleted
before anyone demos this.

> **Resolved 2026-09-24 (phases 11–12).** That row and the other two were all junk
> and all live. `pnpm db:repair-listings` cleaned them, the schema now refuses the
> same input, and `pnpm smoke` fails if a live listing ever drifts again. See
> "Performance & listing integrity" above.

## Done this session (2026-09-24) — the property guide

**`/chat` on apps/web.** A conversational way into the same search. Anthropic tool
calling (`claude-opus-5`, adaptive thinking, `effort: low`), not RAG — embeddings go stale
the moment a price changes, and recommending a withdrawn listing is an AU compliance
problem rather than a relevance one.

- **`packages/ai` is real now** (was three stubs that threw). `models.ts` routes and prices,
  `usage.ts` writes an `ai_run` row **per API request** correlated by `entityId`,
  `prompts/v1.ts` is a frozen literal with the volatile suburb catalogue as a separate
  cache segment (#5), tools and pipeline under `tools/` and `pipelines/`
- **Three tools.** `resolve_location` (returns a suburb and a default radius, **never
  coordinates**), `search_listings` (`channel` + `suburb` required — a model that does not
  know buy-vs-rent cannot form the call), `get_listing`
- **#4 is structural, not a prompt rule.** Tools hand back formatted strings
  (`priceLabel`/`specLine`, moved to `@repo/core/listings/format`), earlier turns carry no
  tool results so the model cannot recall a price, and the results panel renders SQL rows
  rather than model text
- **Cross-questioning is a gate, not an instruction.** Over 25 matches with no budget and
  no bedroom count, the tool returns zero listings and names what is missing. Counting
  costs no extra query (`limit: 61`, measure the pile)
- **NDJSON over a POST route handler**, not SSE — `EventSource` is GET-only and cannot
  carry the conversation. `Accept: application/json` drains the same generator, which is
  what `pnpm smoke` calls, so the parser is never written twice
- **No persistence.** The client holds a narrow validated transcript; it has no way to send
  a tool result, because a tool result is the only source of a price
- Two real bugs found by their own guards: `state: length(2)` refused every NSW/QLD/TAS/ACT
  search (Australian abbreviations are 2 **or 3** letters — now uses `auStateSchema`), and
  a value import of the `./listings` barrel from a client component pulled postgres.js into
  the browser bundle (`Can't resolve 'fs'`). `/chat` ships at 4.08 kB / 110 kB
- Manual cases in `docs/TEST-PLAN.md` § H. H4 (price in the bubble vs the listing page) and
  H12 (`cache_read_input_tokens > 0`) are the two that matter

## Done previously (2026-09-23)
- **Listings are complete.** `updateListing` (listing:edit) and `deleteListing` (new
  `listing:delete`, agency admins only). Delete refuses live / under offer / sold — withdraw
  first, and a sold listing is the record of the sale. The property row is never deleted (#1)
- Edit pages on both surfaces; `ListingForm` does create and edit from one component and
  cannot change status. Table has Edit and a two-click Delete; `canDelete` comes from `can()`
  on the server, so no component compares a role (#2)
- Address matching and agent attachment were duplicated inside `createListing` —
  now `property-resolver.ts` and `listing-agents.ts`, shared with update
- **Location works** (ADR 0007). `property.geom` is a GENERATED `geography(Point,4326)` with a
  GiST index, derived from lat/lng; `geom_wkt` is gone. `packages/core/src/geo/` holds a
  `GeoProvider` port, a Google adapter and a `place_cache` table
- Address autocomplete in the listing form and the agent territory step; location
  autocomplete, radius and beds/baths/cars/type/price/sort on the consumer search.
  Distance is computed with `ST_DWithin`, returned, shown on the card, and sorts by default
- **The radius centre is resolved on the server**, not taken from the URL, whenever a suburb
  is named. A browser sending the wrong centre produced a search that was confidently wrong
  with nothing on screen to show it
- **Suburb and radius are a union, not alternatives.** "Pakenham" means exactly Pakenham;
  "Pakenham + 10 km" means Pakenham AND its surrounds. A suburb can be wider than a radius
  drawn from its own centre, so ANDing them dropped homes on its edges. `state` and
  `postcode` disambiguate — there is a Richmond in four states
- The listing form's suburb field is a picker that fills suburb, state and postcode together
  and shows them back as `Pakenham, VIC 3810`
- **Suburb and pin are separate entities.** The address is printed on the ad and matched by a
  suburb search; the pin is what a map shows and a radius measures. `pinSource = 'manual'`
  records a pin a person placed, and nothing re-geocodes over it
- **Visual maps** via `packages/ui/src/maps/`: a draggable pin in the listing form (satellite
  view), a map on the consumer listing page, and an opt-in results map on search
- **Rent price filters were reading `price_from`**, which rentals never set. They read
  `rent_pw` now. `price_display` is still never parsed (#6)
- **A radius search was being narrowed by suburb**, so "within 6 km of Bondi Beach" dropped
  Paddington 4.5 km away. Suburb is now only the fallback for unpinned listings
- No app imports `@supabase/*` any more — the auth callback moved to `@repo/auth/callback`
- The AI page no longer names an invented agency or ranks it against invented competitors;
  it says no market data is connected and carries a "preview only" banner
- `pnpm --filter @repo/core geo:backfill` gives coordinates to properties that have none —
  created before the key existed, missed by the provider, or pinned by hand. Idempotent, and
  every lookup goes through `place_cache`, so a repeat run costs nothing

## Done previously
- **Invite flow fixed and finished.** Middleware no longer drops `?invite=` for a signed-in visitor;
  `/signup` handles live / expired / accepted / revoked separately (an accepted invite said "expired",
  which told the agent the opposite of the truth); `?invite=` survives the hop to `/login` so an agent
  who already has an account claims by signing in; claim links are built from `NEXT_PUBLIC_AGENT_URL`,
  so an agent never lands on the agency host
- **Pending-invites panel** in the team directory: link stays copyable after the wizard closes, with a
  live countdown and a one-click new link once it lapses (`listAgencyInvites`, `resendAgentInvite`)
- **Auth email links now work at all.** There was no `/auth/callback`, so the PKCE `code` in every
  recovery/confirmation email was never exchanged, and no page existed to set a new password.
  Added `(shared)/auth/callback/route.ts` + `(shared)/reset/update`
- **Redirect loop closed.** `requireConsoleAccess` sends refusals to `/login?error=…`, and middleware
  bounced signed-in users straight back off it — the reason was never readable
- **Listings (new).** `packages/core/src/listings/`: contract, `createListing`, `listAgencyListings`,
  `searchPublicListings`, `setListingStatus`. `listing:create` added to `can()`
- **Both console surfaces** have a listings table and an Add-listing form (one shared component);
  `apps/web` has a search bar, `/search`, and `/listing/[id]`
- **Performance.** `getDb` memoises one pool per connection string (every call opened a fresh pool:
  ~1126 ms cold vs ~182 ms warm, 2–4 pools per page load); `loadActor` no longer reads `listing_agent`
  on every navigation (`loadListingActor` is the opt-in)
- **Clipboard.** "Copy link" claimed success on plain HTTP where `navigator.clipboard` does not exist.
  Now falls back to `execCommand` and, failing that, reveals the link instead of lying
- ESLint 9 flat config shared from `packages/eslint-config`; `next.config.ts` honours `NEXT_DIST_DIR`
  so a throwaway dev server cannot clobber the running one's `.next`

## Agents & Team — made dynamic
- Migration **0004**: `agent_profile.first_name` / `last_name`. The wizard asks for legal names for the
  Fair Trading licence and they were being folded into `user.name`, which cannot be taken apart again
- `listAgencyAgents` now returns the whole profile: legal names, bio, licence class + expiry, territory
  suburbs **and radius**, specialties, languages, commission tier **and both splits**, operational role,
  permission flags, public-profile flag, joined date. A pending invite fills the same shape from the
  stored wizard draft, so the directory looks identical before and after the agent claims
- Team directory drawer replaced with a full dossier grouped as the wizard collects it; licence expiry
  turns red inside 60 days
- Removed the stock avatar (`/stitch/avatars/daniel.jpg`) that made every agent look like one person —
  initials are drawn when there is no photo
- **Hardcoded brand gone.** "Bondi Prestige Group" in the agency sidebar and on every auth screen now
  comes from the database; the agent desk shows the agent's own agency; auth screens name the inviting
  agency when an invite token is in hand and the platform otherwise
- **Invented market numbers gone.** The header showed "Sydney Clearance 74.2% / Metro Median $1.92M".
  It now shows the agency's own live-listing, team and pending-invite counts, sub-selected in the same
  statement that builds the session — so the chrome still costs one round trip (#4: numbers come from SQL)
- `pnpm dev` writes to `.next-dev` and `next build` to `.next`, so a build can no longer break a
  running dev server

## Performance
- One `getUser()` per request (was two). Middleware's verified headers are authoritative and are
  cleared before they are set, so a client cannot supply one
- Independent queries run in parallel; agent names are sub-selected rather than fetched separately
- `loading.tsx` on every route group; `useOptimistic` on publish/withdraw; `useTransition` on forms
- The layout no longer awaits the database. `requireConsoleSession()` reads middleware's headers
  (no network) so the shell paints immediately; the chrome's agency name, role and counts arrive as
  a promise the shells read with `use()` behind Suspense; authorisation runs in `AgencyGate` /
  `AgentGate`, also behind Suspense, so the skeleton is visible while can() decides
- `loadActorContext` is `cache()`d, so the gate and the chrome share one query
- Client router cache: console `staleTimes.dynamic` 120 s, cleared outright by the
  `router.refresh()` every mutation already calls. **Web is 0** — search results must never be
  replayed from a previous run of the same URL, which hid a newly published listing for two
  minutes with no way to tell why
- Server time: `/settings` 478 ms · `/team` 890 ms · `/live-listings` 850 ms (dev).
  Production build: `/settings` 0.65 s · `/team` 1.05 s
- Remaining cost is one auth call plus one query to the database region. Co-locating app and DB in
  Sydney is what removes it

## Performance & integrity (current)
- Writes are atomic: `createListing`, `updateListing`, agent provisioning and both invite-claim
  paths run in `db.transaction`. Geocoding happens **before** the transaction opens
- Public site reads are cached (`apps/web/lib/cached.ts`) and cleared by the console through
  `POST /api/revalidate`, guarded by `REVALIDATE_SECRET` — the two apps are separate processes,
  so `revalidatePath` in one cannot reach the other
- Measured: home 480 → **33 ms**, suburb search 850 → **36 ms**, radius search 1270 → **32 ms**
- Guarded by `query-count.test.ts` (exact query counts per read), `atomicity.test.ts`
  (nothing escapes a transaction) and a smoke group that checks indexes, partial-write
  wreckage and a cold-vs-warm cache ratio

## How to verify
- `pnpm test` — 195 unit tests: 134 in `@repo/core` (permissions, contracts, query shape,
  search-URL vocabulary, formatters) and 61 in `@repo/ai` (the two search gates, the
  pipeline's frame order and metering, request validation, prompt immutability). No
  services needed
- `pnpm smoke` — 53 live checks in 9 groups: migrations + PostGIS, Google
  Places/Geocoding, the suburb-vs-radius invariants, consumer HTTP, speed ratios, every
  console route failing closed, and the AI chat. Needs the dev servers and the database;
  skips cleanly when they are down. **The chat group costs about US$0.02 per run and skips
  entirely without `ANTHROPIC_API_KEY`** — its `#4 end-to-end` check reads every `$` figure
  out of the reply and asserts it came from a tool result
- `docs/TEST-PLAN.md` — the manual cases that need a signed-in browser

## Verified
- typecheck 9/9 · tests 72/72 (21 new listing tests) · lint 9/9 · build 2/2
- Live DB: draft invisible to public search → publish → appears; another agency's owner refused;
  same address twice reuses the property row; price filters read `price_from/to`, never `price_display`
- All 18 wizard fields round-trip against the live DB in both states (pending invite → draft JSONB,
  claimed → agent_profile), probe rows cleaned up afterwards
- Live HTTP: consumer home shows 3 live listings and not the draft; `/search` filters by text, channel
  and beds; `/listing/<draft id>` is 404; all four console listing routes resolve on the right host

## Demo data currently in the DB
**None.** All test listings were cleared with `db:clear-listings` so the surfaces can be
tested from empty. The agency, its two memberships and the agent profile are untouched.

<details><summary>Previously</summary>
5 listings against agency "Saadiii": 4 seeded (Bondi Beach ×2, Paddington, Pakenham) plus one
junk row ("dafdf", Sahiwal NSW 5700) typed in during testing.

All five are now geocoded by Google (`geocode_source = 'google'`); the hand-placed pins are
gone. Re-run `pnpm --filter @repo/core geo:backfill` after adding listings while the geocoder
is unavailable, or with `--redo` to replace any manual pins.

"Saadiii" is the only agency and holds the live owner membership, so deleting it would remove
the way into the console. Renaming it, or registering a real agency and moving across, is a
decision for the user.
</details>

## Blockers / needs from the user
- ~~Google key project mismatch~~ **Resolved.** The first key belonged to project
  `703563155093`; "Places API (New)" had been enabled on `795078746989` ("QuoteMy AI"). A new
  key was issued from that project, restricted to **Places API (New) + Geocoding API** with no
  application restriction. Both verified working; the legacy endpoint is now refused by the
  key's own restrictions, which is correct.
- **`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`** — a **second, different** key for the visual map:
  Maps JavaScript API, restricted by **HTTP referrer**. The server key cannot be used here.
  Without it the maps show a "not configured" panel; pins are still stored and searched
- ~~`ANTHROPIC_API_KEY` is empty~~ **Set, and the chat runs.** All seven AI smoke checks
  pass against the live model
- **Before `/chat` sees real traffic it needs a hard spend cap in the Anthropic console**,
  and a Turnstile or signed page token. The in-process per-IP limiter (10/min) and
  `AI_CHAT_DAILY_TURN_CAP` are ceilings on *accidental* cost, not security controls —
  behind several instances the real ceiling multiplies and a determined caller rotates IPs
- ~~`RESEND_API_KEY` empty~~ **Set, and alert email is wired.** Agent invite
  links are still shared manually — `packages/core/src/email/` is the port to
  route them through when somebody wants to
- No Cloudflare R2 credentials → listings have no photos; `media` table is unused and cards show a
  gradient placeholder
- `site.com.au` is still a placeholder domain. Nothing in code hardcodes it — every host comes
  from `NEXT_PUBLIC_*_URL` / `COOKIE_DOMAIN` — so this is a docs placeholder, not a code one
- **Deleting rows from a script is blocked by the sandbox.** The junk listing ("dafdf" /
  Sahiwal NSW 5700) and the 4 seeded demo listings are still in the database. They can be
  removed from the console with the new Delete button (withdraw first), or by granting a Bash
  permission rule for the migration scripts

## Known placeholders (not built)
- Agency console: overview, leads, customers, calendar, marketing, insights, finance, settings — mocks
- `(agency)/ai` is still a mock, but is now labelled "preview only" and names no invented
  agency. The consumer `/chat` is real; nothing connects the two
- Agent desk nav: Leads / Inspections / Offers are `href: '#'`
- ~~`packages/ai` is empty~~ **Built**, for the consumer chat only: model router, `ai_run`
  metering, prompts, tools and the chat pipeline. Still no listing-copy draft, no lead
  summarising, no Batch API path
- No photos anywhere: `media` is unused and there is no `packages/media`
- ~~No consumer accounts~~ **Built** (magic link, no passwords). No shortlist
  yet; the enquiry form exists
- pgvector is installed but nothing uses it
- ~~No chat threads~~ **Built.** Saved for signed-in visitors only, 90-day
  retention. No export and no cross-device sync beyond the account

## Standing decisions
- Preview off (`NEXT_PUBLIC_UI_PREVIEW=0`); white-label = No; Seoul = dev, Sydney = prod later
- Signup = self-serve agency registration; `AGENT_INVITE_TTL_MINUTES=120`
- Supabase URL config: Site URL is `http://localhost:3000`; `agency.lvh.me:3001` and
  `agents.lvh.me:3001` are allow-listed (confirmed via the admin API)
