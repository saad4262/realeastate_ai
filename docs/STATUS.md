# Status
- Milestone: consumer AI property guide at `/chat`; listings full CRUD; PostGIS radius search
- Build order (locked): Agency UI → Agent UI → Consumer web
- Last tool: Claude Code
- Last updated: 2026-09-24

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
- `pnpm test` — 190 unit tests: 134 in `@repo/core` (permissions, contracts, query shape,
  search-URL vocabulary, formatters) and 56 in `@repo/ai` (the two search gates, the
  pipeline's frame order and metering, request validation, prompt immutability). No
  services needed
- `pnpm smoke` — 46 live checks in 9 groups: migrations + PostGIS, Google
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
- **`ANTHROPIC_API_KEY` is still empty**, so `/chat` answers 503 with a readable reason and
  the four model-dependent smoke checks skip. **The chat has never run against a real
  model.** Everything else about it is verified by unit tests, the build, and live HTTP
  against its guards
- **Before `/chat` sees real traffic it needs a hard spend cap in the Anthropic console**,
  and a Turnstile or signed page token. The in-process per-IP limiter (10/min) and
  `AI_CHAT_DAILY_TURN_CAP` are ceilings on *accidental* cost, not security controls —
  behind several instances the real ceiling multiplies and a determined caller rotates IPs
- `RESEND_API_KEY` empty → invite links are shared manually (the panel makes that workable)
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
- No consumer accounts, shortlist or enquiry form
- pgvector is installed but nothing uses it

## Standing decisions
- Preview off (`NEXT_PUBLIC_UI_PREVIEW=0`); white-label = No; Seoul = dev, Sydney = prod later
- Signup = self-serve agency registration; `AGENT_INVITE_TTL_MINUTES=120`
- Supabase URL config: Site URL is `http://localhost:3000`; `agency.lvh.me:3001` and
  `agents.lvh.me:3001` are allow-listed (confirmed via the admin API)
