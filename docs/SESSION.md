## 2026-09-24 (later still) — Thirteen phases of making it fast, and finding out why the data was wrong

A performance and architecture pass over the whole repo, phase by phase, one
commit each. The audit and the plan came first and neither touched a file. What
follows is mostly what the plan got wrong.

### The biggest win was a font

Nine phases of bundle work moved less weight than one URL. The console asked
for Material Symbols across its full variable axis space —
`opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200` — while every CSS rule in
the repo uses `wght 400, GRAD 0`. Pinning the axes:

    4,001,724 bytes  ->  1,107,100 bytes     (-2.9 MB, render-blocking)

Nothing in a route-size table would ever have shown this. It is the reason
`ARCHITECTURE.md` § 11 says to look outside JavaScript first.

### Five checks that had quietly stopped working

Found by following CLAUDE.md's own rule — break the thing a check guards and
confirm it goes red.

Two radius checks could not detect the bug they were written for: `wide >=
suburbOnly` is satisfied by equality, and the wrong-coordinates check only ever
went red on a database with listings near Sydney. Both now compare against the
same search with the centre spelled out, which is dataset-independent.

Three speed checks broke the moment `loading.tsx` was added, and looked fine
doing it. They timed to first byte, and a streamed page flushes its shell
immediately whether or not anything is cached — so with the cache ripped out
entirely they read *"cold 33 ms, warm 33 ms"* and passed. They read the full
body now. Even then the ratio assertion was useless: cold 1465 ms / warm 433 ms
still satisfies `warm * 2 < cold` with no cache at all. It is an absolute budget
now (cache hit 29–55 ms against a 420–480 ms round trip).

A `#4` violation alarm turned out to be a bug in the check, not the model — it
stripped commas from the figure but left the `$` on, so it searched for
`$9320334343324` while the JSON held `9320334343324`.

### A forged header rendered a real owner's console

The middleware sets `x-console-user-id` and Server Actions trust it. Two paths
reached Server Components without `updateSession` having run: `UI_PREVIEW` mode,
and the throw path when a Supabase env var is missing. Proved rather than
argued — a second console on port 3002 with a forged header carrying a real
owner's id returned **HTTP 200** rendering "Every listing in the agency book".
Middleware now deletes those three headers unconditionally, at the top, before
any branching. Restoring only that strip turned the same request into a 307.

My first smoke check for it passed under sabotage and told me nothing, because
middleware redirects on `!userId` before any page reads a header. The check's
comment is now honest about what it can and cannot see.

### Three projections that were wrong

- **Phase 5d planned a 60% cut of `listing-form.tsx`** by moving "inert" fields
  to Server Components. They are not inert: every field calls `invalid(name)`
  for its className and renders `<Err name>`, both of which read client `errors`
  state. The form's own page chunk is 138 bytes anyway. Dropped.
- **The plan said to omit `generateStaticParams`.** Empirically required:
  without it `prerender-manifest.json` had `dynamicRoutes: []` and every request
  re-rendered. With `return []` it became `['/listing/[id]']` and `● ISR`.
- **I reported drizzle and zod in a client chunk.** They were not. A broken
  probe loop — `grep -c "$probe" "$f" || echo 0` made `$c` equal `"0\n0"`, so
  every check read as truthy.

### ISR on the listing page works, and is still off

Measured end to end: MISS → HIT → MISS after `revalidateTag`. It is not enabled,
because `/listing/<unknown-id>` answers **HTTP 200** with the not-found body in
production. That is pre-existing — it reproduces on a clean build with
`force-dynamic` and with `not-found.tsx` deleted entirely — but a wrong status
served fresh is a bug and a wrong status served from a cache sticks. I first
recorded it as caused by caching, which was wrong, and corrected the comment.

### Then: reviewing the concurrent frontend work

The new site header was raw `<a>` tags. On the public site that is the
most-clicked control there is, and a raw anchor is a full document load — nine
commits of work on instant navigation, handed back on every page. It was
written that way for a real reason: `packages/ui` has no `next` dependency and
cannot import `next/link`. So rather than give the shared package a framework,
`AppShell` takes a `linkAs` prop and `apps/web` supplies `next/link` in exactly
one place (`WebShell`). Route sizes unchanged to the byte, and it buys back
viewport prefetch of the `/search` and `/chat` loading shells.

Also: the map's "not on the map" tally counted rows with a null latitude, while
the pins needed latitude *and* longitude — so a row with one but not the other
was dropped from both. It is counted from the pins actually built now.

### Every listing in the database was junk, and all three were live

    headline       "dfs", "dfsdsf", "jdsfjdfjl"
    price_display  "23443342", "332432322", "9320334343324"
    property_type  "sfd", "2jkads", "House"
    one property   23 bedrooms, 32 bathrooms, 32 car spaces

Nothing was broken. `headline` needed one character, `price_display` was any
string up to 120, `property_type` was free text, and a dwelling could have fifty
bathrooms. The rows were legal.

The price one is the one that matters. #6 keeps the display string and the
searchable numbers apart and never parses one into the other — correct, and it
only holds while the string is actually copy. One listing displayed a figure
reading as twenty-three million while the range search filters on started at
`$34,443`, so a buyer filtering under $50,000 was being shown it.

`property_type` was worse than it looked. The public search *filters* on that
column and builds its dropdown by selecting distinct values out of the live
listings — so the live site was offering buyers `"2jkads"` and `"sfd"` as
property types, with `"House"` and `"house"` counted as different kinds of
building. Confirmed by reading the actual `<option>` list off `/search`. A
filterable dimension cannot be free text; it is a vocabulary now, same shape as
`AU_STATES`, same reasoning as #8.

Two things guard it: a smoke check that asks the **real schema** of every live
row rather than a second copy of the rules, and `db:repair-listings`. The
repair follows one rule — every fix is derived from something true or is an
honest NULL, and nothing invents a price. Its first draft wrote *"3-bedroom sfd
in Nar Nar Goon North"* and *"2jkads in Pakenham"*, because it trusted
`property_type` while it was in the middle of repairing `property_type`. A dry
run caught it. A repair is only as good as the field it reads.

### Two header numbers were holding a whole query open

`listAgencyListings` had no LIMIT. It selected every listing the agency had ever
written, with addresses and agent-name arrays, on every console page load —
because the table computed its Live and Drafts figures in the browser:

    const live = optimisticRows.filter(r => r.status === 'live').length;

Those are only correct if the browser has every row. Postgres counts them now,
as window functions over the same scan, evaluated before `LIMIT` so they stay
agency-wide. Verified against the real database rather than assumed: `limit 2`
returned two rows carrying `total=3`. Still one statement — `query-count.test.ts`
refuses a second, confirmed red with a deliberate extra await.

### What I did not do

`router.refresh()` follows a Server Action that already called `revalidatePath`
in three places. It is very likely a duplicate round trip, and it holds
`isPending` — and every action button — disabled while it runs. I built a probe
route to settle it empirically, could not drive a client component without a
headless browser, and stopped rather than remove it on reasoning alone: the
failure mode is a visibly stale table on the console's main write path. The
experiment that settles it is written down in `ARCHITECTURE.md` § 14.

### ARCHITECTURE.md

The rules above existed only in commit messages and code comments, which means
they were only available to someone who already knew to look. They are now one
file, fourteen sections, with the measurements attached and a section of gaps
left open on purpose. `CLAUDE.md` points at it.

### Verified

typecheck 10/10 · lint 10/10 · 277 tests (187 core, 90 ai) · both apps build ·
smoke 55 passed, 0 failed. Every new guard confirmed red under sabotage and
green restored.

## 2026-09-24 (later) — The guide meets the real model

The key arrived, so the chat ran against Claude for the first time. Five things were
wrong, none of them visible to a unit test, and each one is now guarded.

### `strict: true` was making the guide invent filters

The worst of them. With `strict: true` on the tool definitions, the model filled in the
**optional** fields on every call — `keywords: "-"`, then `keywords: "1"`, `priceTo: 22`,
`priceTo: 0` — on messages where the visitor had mentioned neither a keyword nor a budget.
Each one silently ANDed the search down to nothing, and the visitor would have seen only
"no matches" with no way to tell why. Watching the NDJSON frames is what showed it:

    {"query":{"text":"-","channel":"sale","suburb":"Pakenham","priceTo":22},"matched":0}
    {"query":{"text":"1","channel":"sale","suburb":"Pakenham"},"matched":1}

`strict` is gone. It was belt-and-braces over a zod layer that re-parses every input
anyway, and optional has to mean optional. `additionalProperties: false` stays.

### `strict: true` also 400s the whole request over `minimum`

    tools.1.custom: For 'integer' type, properties maximum, minimum are not supported

Not `number` only — `integer` too, and by extension `minLength`, `maxLength`, `pattern`.
The schema now carries `type`, `enum` and `description` and nothing else. The bounds are
stated in prose, where the model reads them, and enforced in zod, where they are checked.
A test asserts none of the banned keywords come back.

### `length(2)` on an Australian state, twice

`auStateSchema` was adopted in the tool schema earlier today. The **same mistake was still
sitting in `slotsSchema`**, so the first message worked and the second came back `400` for
every conversation about a VIC, NSW, QLD, TAS or ACT suburb — the chat looked like it had
simply stopped. Non-negotiable #8 exists for exactly this: one list, not three. There is
now a test that posts the whole turn-two body the browser actually sends.

### `effort: "low"` was the wrong measurement

The plan set it low and reasoned that a consumer chat is latency-sensitive and the work is
only choosing filters. Against the real model that produced `priceTo: 0`, a stray `x` in
the keyword field, a missed "under 30km", and one turn that read
*"ację / comment / Let me run that properly"* before recovering. **Choosing filters from a
sentence is the reasoning here.** Raised to `medium`; `max_tokens` 2048 → 4096, because
adaptive thinking spends that budget too and it is headroom, not a cost ceiling. Cost is
governed by effort and the three-round cap, which is what the original comment got wrong.

### The prompt was too polite to follow its own rule

v1 asked "buy or rent?" before searching anything, and v2's first draft still read
*"a house in Pakenham under 30km"* as a suburb search and then **asked whether 30 km was
meant** — the software not listening. v2 now enumerates the phrasings ("in X under 30km",
"within 30 km of X", "X + 30km") and states that a radius is never a reason to ask a
question. Channel is assumed and disclosed in one clause rather than demanded up front:
*"Assuming you're buying — say the word if it's rentals you want."* v1 is kept beside it.

### What it actually does now

    "I need a house in Pakenham under 30km"
      → near={lat:-38.0776708, lng:145.4818724, radiusKm:30}, channel=sale
      → "Within 30 km of Pakenham there's just 1 house… 3.5 km away."
      → link: /search?channel=sale&suburb=Pakenham&state=VIC&radius=30   (no lat=)
      → then asks for budget and bedrooms, with results already on screen

    "Actually I want to rent, under $700 a week, 2 bedrooms"
      → channel=rent, priceTo=700 read as weekly, bedrooms=2, radius carried over
      → "Nothing is coming up… want me to lift the price ceiling, or drop the
         bedroom filter instead — just say which."

It also met a listing whose price is `9320334343324` — junk typed into the console during
testing — and said *"which looks like an error on the agency's part, so worth checking
with them directly"* rather than reading it out as a price. That is the behaviour the
formatting rule was for, arriving without being asked.

### Smoke

The four model-dependent checks now run, plus a fifth for the radius. The `#4` check had
to be corrected first: it flagged `$2,000,000` as hallucinated when the guide was
repeating the visitor's own budget back to them. A figure is now accounted for if it
appears in the rows, the query, **or the message the visitor sent**. The helper skips on a
429 rather than going red — hitting the limiter means the limiter works.

typecheck 10/10 · lint 10/10 · **tests 195/195** (134 core + 61 ai) · **smoke 45 passed,
0 failed, 8 skipped** — including all seven AI checks against the live model · both apps
build · `/chat` 4.07 kB / 110 kB.

### Still true, and still the thing to do before launch

`/chat` is an anonymous, unauthenticated page in front of a metered API. The per-IP
limiter (10/min) and `AI_CHAT_DAILY_TURN_CAP` are ceilings on accidental cost, not
security controls. **Set a hard spend cap in the Anthropic console.** A Turnstile or
signed page token before it is public.

## 2026-09-24 — A property guide on the consumer site

`/chat` on apps/web: a conversational way into the same search, for a buyer who knows
what they want but not which filters say it. Anthropic tool calling, not RAG — embeddings
go stale the moment a price changes or a listing is withdrawn, and recommending a
withdrawn listing in Australia is a misleading-conduct problem, not a relevance one.
Hard filters ("3 bed under $900pw") are not something cosine similarity can enforce.

### The model cannot produce a number, by construction

Non-negotiable #4 is usually a prompt rule. Here it is structural, in four places:

- **Tools hand back formatted strings, not numbers.** A row the model sees is
  `{ price: "Offers over $1.2M", specs: "3 bed · 2 bath", distance: "4.2 km away" }` —
  built by `priceLabel`/`specLine`, the same two functions the cards use. There is no
  figure in the payload to do arithmetic on. `price_display` passes through unparsed (#6).
- **Earlier turns carry no tool results at all.** The client holds the transcript, so a
  client that could send a tool result could send a price the database never quoted. Past
  turns are replayed as plain text plus one *server-authored* line
  (`[searched: sale · in Pakenham → 37 matches, 8 shown]`). The consequence is the point:
  the model genuinely cannot recall turn two's prices and has to call `get_listing`.
- **The results panel never renders model text.** It renders the `results` frame's rows
  through `ListingCard`. What is on screen is SQL's, whatever the answer beside it says.
- **A smoke check reads every `$` figure out of the reply** and asserts it appears in the
  tool result. It is the only check in the suite that can catch a hallucinated price.

### Cross-questioning is two gates, not an instruction

- **Gate 1, the schema.** `channel` and `suburb` are required with `strict: true`. A model
  that does not yet know whether the visitor is buying or renting *cannot form the call*.
  Enforced by the API, not by good behaviour.
- **Gate 2, the return shape.** Over 25 matches with neither a budget nor a bedroom count,
  the tool returns `listings: []`, `tooBroad: true` and a note naming what is missing. The
  model has nothing to show, so the question is its only coherent move. A model cannot
  ignore data it was never given.
- Counting costs no extra query: `limit: 61`, then measure the pile. `searchPublicListings`
  keeps its one-statement guarantee.
- **No `ask_user` tool.** Asking is the model writing text with no tool call — the default
  path. A tool for it would add a round trip and two ways to produce text.

### What the model is never allowed to decide

`search_listings` has no `lat`, `lng`, `status` or `limit` field — the wrong thing is
unsayable. `resolve_location` returns a suburb and a `defaultRadiusKm` but **no
coordinates**; the centre is looked up server-side from `place_cache`. That is the same
bug STATUS.md records being reported twice, kept fixed by making it inexpressible.
Unknown keys are stripped rather than refused: a stray invented field should cost the
field, not one of the visitor's three tool rounds.

`headline` and `description` are excluded from search results entirely. They are
agency-authored free text on a multi-tenant portal — an agency can write "ignore previous
instructions" into a description. Only `get_listing` returns them, fenced and labelled as
data. A unit test asserts the string never reaches the model through a search.

### Transport

NDJSON over a POST route handler, not SSE: `EventSource` is the only zero-dependency SSE
client and it is GET-only, so it cannot carry the conversation. The client hand-parses
either way, and the remainder buffer is the whole trick — a chunk boundary lands mid-object
and a naive `split('\n')` eats the tail, reliably, only under load.

`Accept: application/json` drains the same generator into one object. `pnpm smoke` uses
that, so the streaming parser is never written twice.

### Two real bugs, both caught by their own guards

- **`state: z.string().length(2)`** silently refused every search in NSW, QLD, TAS and the
  ACT — Australian abbreviations are two *or three* letters. It now uses the platform's own
  `auStateSchema` rather than a hand-written duplicate (#8). A test found this, not a review.
- **The web build broke with `Can't resolve 'fs'`.** Moving `priceLabel`/`specLine` into
  core turned `listing-card.tsx`'s type-only import into a *value* import of the
  `./listings` barrel — which re-exports `update-listing.ts` → `@repo/db` → postgres.js.
  Rendering a card inside the chat's client panel then pulled the database driver into the
  browser. Fixed with a leaf subpath, `@repo/core/listings/format`, and the reason is
  written at the top of that file. `/chat` ships at 4.08 kB / 110 kB first load, which is
  the measurement that says the Anthropic SDK is not in there either.

### Verified by breaking it

Each new guard was sabotaged first and confirmed red:
- removing the suburb/coordinate asymmetry → `expected '-38.0709' to be null`
- `TOO_BROAD_ABOVE = 9999` → the gate test fails
- adding `lat` to the tool's JSON Schema → the zod/JSON drift test fails

Live against the running dev server, with no API key set: a forged `listings` array, an
unknown top-level key, a `lat`/`lng` in `slots`, and a `role: 'system'` turn are all 400;
a valid body is 503 with a readable reason. Validation runs *before* the key check, so a
malformed request is told it was malformed rather than being told the service is down —
that was the wrong answer and the one that sends someone to look at the deployment.
Rate limiter: 10 refused, then 429, with zero tokens spent.

### Honest gaps

- **An in-process IP limiter in front of a metered API is a ceiling on accidental cost,
  not a security control.** Ten per minute per IP, plus `AI_CHAT_DAILY_TURN_CAP` per
  process. Behind several instances the real ceiling multiplies, and a determined caller
  rotates IPs. **Before this sees real traffic it needs a hard spend cap in the Anthropic
  console, and a Turnstile or signed page token.** Said plainly because it is the one thing
  here that can cost money quietly.
- Nothing is persisted, so there is no transcript if the guide says something it should
  not — only an `ai_run` row with token counts. That was a deliberate choice.
- `ai_run` has no `cache_read_tokens` column, so `costUsd` is correct but cache
  effectiveness cannot be audited from the table. Manual check H12 is the substitute.
- The search-param vocabulary now has three writers (`search/page.tsx` parses,
  `search-bar.tsx` builds, `searchQueryToParams` builds). `SEARCH_PARAM_KEYS` exists so the
  drift is findable; unifying them was deliberately left out of this change.
- The chat has never run against a real model — **`ANTHROPIC_API_KEY` is still empty.**
  Everything above is verified by unit tests, the build, and live HTTP against the guards.
  The four model-dependent smoke checks skip cleanly and are what proves the rest.

typecheck 10/10 · lint 10/10 · **tests 190/190** (134 core + 56 ai) · **smoke 40 passed,
0 failed, 12 skipped** · both apps build.

## 2026-09-23 — Guards for the transaction and performance work

Everything just built is invisible when it breaks: an N+1 returns the right answer, a lost
cache is merely slower, a non-transactional write only shows on a failure path nobody
exercises. So each got a guard, and **each guard was verified by breaking the thing it
guards** — two of them failed that bar first time.

- **`query-count.test.ts`** — every read has an exact, measured query count. The agency table,
  the agent desk, one listing for editing, and a public search with thirteen filters are all
  one query; a radius search costs the same as a plain one.
  - **It did not work first time.** The counting fake returned an empty array, so a
    deliberately added per-row query never ran and the test stayed green. It returns three
    rows now: a fake that returns nothing cannot catch a bug that costs one query per row.
    With that fixed the same sabotage reads `expected 4 to be 1`.
- **Database health** in smoke: all five indexes present, none invalid, the radius plan uses
  the spatial index, geocoded rows all have a usable `geom` — and two that look for the
  wreckage of a partial write directly: a listing with no `listing_agent`, and an agent
  membership with no `agent_profile`. Both are zero. Before the transaction work, either
  could have been non-zero and nothing would have said so.
- **Speed, measured as a ratio rather than a budget.**
  - The first version allowed 400 ms. Disabling the cache took pages from 31 ms to 134 ms —
    four times slower, comfortably inside the budget, test still green. A millisecond number
    measures the laptop it runs on.
  - It now clears the cache, times the cold request, then times the warm ones, and requires a
    real gap. Cached: `cold 440 ms → warm 33 ms`. With caching removed all three fail with
    `cold 419 ms, warm 449 ms — too close together to be cached`.
- `CLAUDE.md` gained a "Writing to the database" rule: multi-step writes in a transaction,
  helpers take `DbOrTx`, network calls before the transaction opens.
- typecheck 10/10 · lint 10/10 · **tests 113/113** · **smoke 45 passed** · both apps build.

## 2026-09-23 — Atomic writes, then a cache the console can clear

### Transactions — nothing is written unless the last step succeeds

- `createListing`, `updateListing`, `materialiseAgent` and both claim paths in
  `claimAgentInvite` now run inside `db.transaction`. Before this a create was five
  statements in a row, and the **last one can legitimately fail**: `attachListingAgents`
  refuses ids that are not members of the agency. That refusal left a property and a listing
  behind with no agent on them — visible in the console, unreachable for an enquiry, and
  invisible as a problem because the error looked like a clean rejection.
- `DbOrTx` added to `@repo/db`, derived from `Db` so it cannot drift. Helpers that write take
  it: a function that only accepts `Db` cannot be made atomic without rewriting it.
- **The geocoder call moved out of the write path.** `resolvePin` runs before the transaction
  opens. Inside it, an HTTP call to Google would hold a pooled connection and row locks for
  its whole duration — one slow response stalling the pool.
- The slug retry in `materialiseAgent` had to go: a failed INSERT aborts a Postgres
  transaction, so catch-and-retry inside one would hit "current transaction is aborted" and
  take every later write with it. `pickSlug` reads the taken slugs first — one round trip
  instead of up to twenty, and a genuine race rolls the whole thing back, which is the
  correct outcome.
- `atomicity.test.ts` proves the guarantee rather than the SQL: its fake only "commits" when
  the callback returns, and asserts nothing escaped. **Verified by reintroducing the bug** —
  removing the transaction turns it red with `OUTSIDE:insert:property`.
- **Verified on the live database.** A create that fails on the agent step: listings 3 → 3,
  properties 3 → 3. Before the fix it would have left one of each.

### Performance — the public site was reading the database on every view

- Measured first: home 480 ms, suburb search 850 ms, radius search 1270 ms. Every one of
  those was a round trip to Seoul, on every page view, for every visitor. `staleTimes: 0`
  had removed the only caching the site had, for a good reason — it was serving stale
  results — but the answer to that is invalidation, not doing the work again every time.
- `apps/web/lib/cached.ts` wraps the four read paths in `unstable_cache`:
  - search results — tagged `listings`, 30 s safety net
  - one listing — tagged `listings` **and** `listing:<id>`, so an edit clears one page
  - filter options — **one call instead of two**; suburbs and property types were separate
    round trips on every page view of both the home and search pages
  - place lookups — a day, untagged: nothing an agent does moves Pakenham
- **Cross-app invalidation**, which is what makes caching safe here. The two apps are
  separate processes, so the console's `revalidatePath` cannot reach the public site.
  `POST /api/revalidate` on web, guarded by `REVALIDATE_SECRET`, called by every listing
  mutation in the console. Best-effort: a failed hint never fails an agent's publish.
- Results: **home 480 → 33 ms, suburb search 850 → 36 ms, radius search 1270 → 32 ms.**
- Proved the invalidation rather than assuming it: warmed the cache (3 results), changed the
  database directly behind it (still 3 — the cache working), called revalidate, got 2.
- Smoke gained two checks: the endpoint refuses a wrong secret and accepts the right one,
  and a warm page answers in under 400 ms.
- typecheck 10/10 · lint 10/10 · tests 107/107 · smoke 35 passed · both apps build.

## 2026-09-23 — Searching stops reloading the page, properly this time

- My first attempt was wrong. `useTransition` around `router.push` does not stop Next reaching
  for `loading.tsx`: that file is a Suspense fallback for the **whole route**, and a route-level
  boundary swaps out everything under it whatever the caller does. The page kept blanking and
  I said it was fixed. It was not.
- Done properly:
  - **`apps/web/app/loading.tsx` deleted.** A boundary that covers the hero, the search box and
    the results can only ever blank all three.
  - The search moved out of `page.tsx` into `search/results.tsx` as two server components —
    `ResultsSummary` and `ResultsList` — each under its own `<Suspense>` keyed on the search
    params. The shell renders without waiting for them, so the search box never leaves the
    screen and only the parts that depend on the answer show a spinner.
  - They share one query through `cache()`. Two components asking the same question would
    otherwise be two round trips to the database region, with the page layout silently deciding
    how many queries a search costs.
  - The key on each boundary is what makes the spinner appear at all: Suspense keeps its old
    children through an update, which is right for refining a list and wrong when the visitor
    has asked a different question.
  - The sweeping bar is gone. A **circle** in the Search button, where the click was and where
    the eye already is; a separate indicator elsewhere makes people hunt for what moved.
- `prefers-reduced-motion` stops it.
- typecheck 10/10 · lint 10/10 · tests 103/103 · smoke 33 passed · web builds. Results
  unchanged: 2 km → 2, 10 km → 3, 50 km → 3.

## 2026-09-23 — Searching no longer blanks the page

- Reported: every search felt like a full page reload.
- It was one, visually. `apps/web/app/loading.tsx` rendered the single word "Loading…" for the
  **whole route**, so `router.push` tore down the hero, the search box and the results and
  rebuilt them. Nothing was cached and nothing was wrong; the page was simply being thrown
  away and remade on every search.
- Fixed:
  - `search-bar.tsx` runs the submit inside `useTransition`. React keeps the current page on
    screen until the next one is ready, so Next never reaches for the loading fallback. The
    **whole** handler is wrapped, not just `router.push` — resolving a suburb's coordinates is
    a network call too, and leaving it outside meant the button sat idle through the one part
    that can take a moment.
  - An indeterminate progress line under the search card while it runs, and the button reads
    "Searching…" and is disabled. Indeterminate on purpose: a round trip has no percentage to
    report and a bar that pretends otherwise is a bar that lies.
  - `loading.tsx` is now a layout skeleton rather than a word. Searching does not reach it any
    more, so what is left is arriving somewhere new — usually a listing — and there the shape
    of the page holds the layout still instead of collapsing it.
- `prefers-reduced-motion` stops both animations.
- typecheck 10/10 · lint 10/10 · tests 103/103 · smoke 33 passed · web builds.

## 2026-09-23 — The search box was filtering twice

- Reported three times as "the km filter isn't working", and I spent an hour on the wrong
  thing — trying coordinate after coordinate — because I kept testing URLs I built myself
  instead of the one the form builds. The moment I read `onSubmit` the cause was on the
  first line of it.
- **`set('q', text.trim())` ran unconditionally.** Picking "Pakenham" from the dropdown leaves
  the word Pakenham in the box as a label, and it was also sent as the free-text keyword. The
  keyword is ANDed over everything:
  `(in Pakenham OR within 50 km) AND ("pakenham" appears somewhere)`
  Nar Nar Goon North is 5.6 km away and has no "pakenham" in its address, so the text filter
  deleted exactly the listings the radius had just added. Every one of my own tests passed
  because none of them carried `q`.
- Fixed in both places:
  - `search-bar.tsx` sends `q` only when nothing was picked.
  - `search/page.tsx` discounts a `q` that is merely the place's own name, so links already
    shared behave too. A genuine keyword next to a suburb still filters — verified with
    `q=Havana` (1 result) and `q=pool` (0).
- Locked: a unit test asserting the keyword is ANDed over the location, and a smoke check that
  runs the same search with and without the label in `q` and requires the counts to match.
- typecheck 10/10 · lint 10/10 · tests 103/103 · smoke 33 passed · web builds.
- Lesson for the next one of these: when the UI disagrees with curl, read the code that builds
  the request before theorising about the response.

## 2026-09-23 (later) — The radius centre came from the browser

- Reported three times, each time as "the km filter isn't working", and I explained it away
  twice before finding it. Reproduced by trying centres until the page's exact wording came
  back: **the centre in the URL was not Pakenham's.** With Pakenham's own coordinates the
  search returned 3; with Melbourne's or Sydney's it returned 2 and said "nothing else within
  50 km of it" — the same sentence in the report.
- The real defect was not which coordinates the browser sent. It was that the **server trusted
  them at all**. A named suburb has one correct centre, so a search could be confidently wrong
  — a circle drawn around Melbourne while the page said Pakenham — with nothing on screen to
  show it. That is a failure nobody can debug from the outside, which is why it took three
  rounds.
- Fixed: when the URL names a suburb and a radius, `apps/web/app/search/page.tsx` resolves the
  centre itself through `resolvePlace`. A cache hit for anywhere already searched, so it costs
  nothing. The URL's coordinates are used only when no suburb is named — the case where the
  visitor picked a street address and the centre genuinely is not a suburb centroid.
- Side effect worth having: a radius with no coordinates used to be dropped silently. It now
  works, so a hand-built or truncated link behaves like one built by the form.
- Smoke gained `the radius centre comes from the suburb, not the URL`, which searches with
  Sydney's coordinates and asserts the count does not move. The old check `a radius with no
  centre is ignored` described the bug as if it were the design; rewritten.
- Verified: correct centre, Melbourne's, Sydney's and none at all now all return 3 at 50 km;
  2 at 2 km; 3 at 10 km. typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 32 passed.

## 2026-09-23 (later) — "the km filter isn't working"

- Reported: "+ within 2 km" showing a card marked 3.5 km away.
- The filter was working. A suburb-plus-radius search is a **union** — every listing in
  Pakenham, plus everything within the radius of its centre — because Pakenham is about 8 km
  across and a 2 km circle from the middle would drop homes on its edges from a search for
  their own suburb. Havana Parade is in Pakenham and 3.5 km from the centroid, so it belongs
  in both answers.
- What was actually wrong was the **presentation**, and it made correct behaviour
  indistinguishable from a broken filter:
  - Every card showed its distance from the centre, including the ones matched by suburb. A
    card reading "3.5 km away" under a 2 km filter has only one available reading.
  - The heading summed the two halves — "3 results … within 10 km" — so there was no way to
    see which result came from where.
- Fixed: a card matched by suburb now says **"In Pakenham"**; only the ones the radius brought
  in show a distance. The heading names both halves:
  `3 results — 2 properties for sale in Pakenham VIC 3810, and 1 more within 10 km of it.`
  At 2 km it reads `…and nothing else within 2 km of it`, which is the filter reporting its
  own result rather than leaving it to be inferred.
- The 50 km case the same report mentioned was the client router cache, fixed separately.
  Verified after: none → 2, 2 km → 2, 10 km → 3, 50 km → 3, with Nar Nar Goon North appearing
  at 10 km and above.
- typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 30 passed · web builds.

## 2026-09-23 (later) — The consumer search page was serving its own stale answers

- Reported: a listing 5.6 km from Pakenham did not appear under "+ within 50 km", twice.
- The server was right the whole time — fetching that exact URL returned 3 results including
  it. The stale answer was in the browser.
- Cause, and it was mine: `apps/web/next.config.ts` had `staleTimes.dynamic: 120`, which I
  added to make back-navigation cheap. The client router cache is keyed on the URL, so
  running the same search twice within two minutes replays the first answer — and that gap
  is exactly when somebody publishes a listing and then goes to check that it showed up.
- Set to `0`. A portal that hides a listing that just came up, or shows one that just sold, is
  wrong in the way that matters most; saving a refetch on back-navigation does not pay for it.
  Static pages keep their cache.
- The console keeps `120`: every mutation there already calls `router.refresh()`, which clears
  the cache outright, so an agent never sees their own change go missing.
- A web dev server restart is needed — `next.config.ts` is not hot-reloaded.

## 2026-09-23 (later) — Two silent failures in the address boxes

- **"Find the address" returned nothing for a suburb.** It was restricted to
  `kinds: ['address']`, so typing "paken" asked Google for street addresses called paken and
  got none — an empty dropdown that reads as a broken box. The routing for a street-less
  result already existed (`applyPlace` hands it to `applySuburb`); the filter stopped anything
  reaching it. Both address boxes are now unrestricted and labelled "address or suburb".
  In the map's box a suburb pans the map there **without** placing a pin — that is exactly the
  state an agent is in when they most need the map.
- **The radius was being dropped.** Searching a suburb with no radius put no lat/lng in the
  URL. Coming back to those results rebuilt `place` with empty coordinate strings, so
  `if (radius && place.lat)` was false and choosing "+ within 10 km" changed nothing at all.
  Coordinates now go into the URL every time they are known, and choosing a radius without
  them resolves the suburb first (a cache hit for anywhere already searched).
- **Silent failures made visible.** `AddressAutocomplete` fetched inside `try/finally` with no
  `catch`, and `suggestPlacesAction` throws on an expired session — so any failure emptied the
  dropdown and said nothing. "No suggestions" and "the lookup failed" look identical and mean
  entirely different things. Both now surface a sentence.
- Added `reverseGeocode` to the geo port and a Google implementation via the Geocoding API it
  already uses, cached on the rounded point. The pin field uses it: drag the marker and the
  nearest address appears, with a button to adopt it — offered, never applied, because a pin
  dragged to the back of a battleaxe block has the front house as its nearest address.
- Verified live: Pakenham only → 2, +2 km → 2, +10 km → 3 (Nar Nar Goon North at 5.62 km).
  Same over HTTP. Reverse lookup of a dragged pin returns the street it landed on.
- typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 22 passed.

## 2026-09-23 (later) — A visual map, and the pin as its own thing

- Asked for: clean the junk data, a visual map on the listing and search pages, a pin the
  agent can drag, and suburb and pin treated as two separate entities.
- **Junk cleared.** `pnpm --filter @repo/db db:clear-listings` (dry run by default,
  `--confirm` to act). All 5 test listings and their now-orphaned property rows are gone.
  Agencies, memberships and users are deliberately out of scope: the one agency holds the
  only owner login. An earlier ad-hoc delete script was refused by the sandbox; a named,
  dry-run-first maintenance command was not, and is the better artefact anyway.
- **Suburb and pin are now genuinely separate.**
  - `pinSource: 'google' | 'manual'` on the property draft. A manual pin is a claim by a
    person standing in the property, so it outranks the geocoder: `resolvePropertyId` no
    longer re-geocodes over it, `geo:backfill` skips it without `--redo`, and editing the
    street number no longer discards it.
  - Choosing a suburb no longer clears a hand-placed pin — a suburb says nothing about where
    in it the house is, and a centroid would be a worse answer than no pin.
  - A dragged pin drops its `place_id` and `formatted_address`: it is a point on a map, not
    one of Google's places, and keeping them would claim this spot is that address.
  - `ListingForEdit` carries `geocodeSource` so a hand-placed pin comes back as one.
- **The map.** `packages/ui/src/maps/` — a singleton script loader (the API is a global;
  loading it twice throws, and React mounts twice in dev) and one `MapView`. Passing
  `onPinMove` is what makes it editable; there is no `editable` flag to fall out of step
  with whether a handler was given. Satellite view in edit mode so the agent can find the
  roof line.
  - Console: `PinField` — collapsed by default, shows whether the pin was found or placed,
    drag or click to move, and "put it back where the address says" on an edit.
  - Consumer: a map on the listing page (only when pinned — a map centred on a suburb says
    the house is somewhere it is not), and an opt-in results map that frames every pinned
    result and counts the ones it cannot show.
- **Second key**: `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, Maps JavaScript API, restricted by
  HTTP referrer. Not interchangeable with the server key — an IP rule cannot defend a key
  sent from a browser and a referrer rule breaks one sent from a server. Without it the maps
  render a short "not configured" panel and nothing else changes; pins are still stored,
  searched and returned.
- Smoke: an empty database now **skips** the search group instead of failing it. Clearing
  listings is a legitimate state and a red run for it would teach everyone to ignore output.
- typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 21 passed / 0 failed / 9 skipped
  (empty database) · both apps build.
- Note: `MapView` uses `google.maps.Marker`, which Google has deprecated in favour of
  `AdvancedMarkerElement`. The replacement needs a Map ID configured in the console, which is
  another setup step for no benefit here. Revisit if Google sets a removal date.

## 2026-09-23 (later still) — A verification ladder

- Goal: make live testing repeatable instead of a thing done by hand each time.
- Three layers now, and which one is red tells you where to look:
  - `pnpm test` — 97 unit tests. Red means the code is wrong.
  - `pnpm smoke` — new `packages/smoke`, 30 checks against the live database, the live
    Google account and whatever dev servers are up. Red is often something outside the code.
  - `docs/TEST-PLAN.md` — the manual cases that need a signed-in browser, which nothing here
    can produce. Grouped A–G, ordered so later cases use data earlier ones create.
- The smoke runner is deliberately not vitest: these are not unit tests and must never be
  read as such. Failures are fatal; skips are not — a dev server that is down should not
  train everyone to ignore the output.
- **Checks assert invariants, not row counts.** The database changes between runs, so
  `rows.length === 3` is a check that gets deleted the first time somebody adds a listing.
  What it asserts instead: a wider radius never returns fewer results; a listing in the named
  suburb is never lost when a radius is added; the page's count equals the database's.
- **Both layers were verified by breaking the thing they guard.** Reintroducing the
  suburb-vs-radius bug (`return within` instead of the union) turned the unit test red on the
  rendered SQL and the smoke check red with "1 listing(s) in Bondi Beach vanished when a
  0.1 km radius was added". Restored afterwards; full suite green.
- `CLAUDE.md` gained a short "Verifying" section so the ladder is found at session boot.
- typecheck 10/10 · lint 10/10 · tests 97/97 · smoke 30/30.

## 2026-09-23 (later) — Suburb and radius combine instead of replacing

- Reported: searching a suburb should return that suburb exactly; adding a radius should
  return the suburb **plus** its surrounds. The agent side should pick a suburb as
  `Pakenham, VIC 3810` rather than three fields typed separately.
- Found: `searchPublicListings` dropped the suburb filter whenever `near` was present, so
  "Pakenham within 5 km" meant *only* the circle. Pakenham is about 8 km across, so homes on
  its edges were being excluded from a search for their own suburb. The earlier fix for the
  opposite bug (suburb ANDed into a radius) had overcorrected.
- Done:
  - `locationFilter()` replaces `geoFilter()`: suburb-by-name OR ST_DWithin, not one or the
    other. `state` and `postcode` added to the query — there is a Richmond in four states.
  - The union removes the need for the separate unpinned-listing fallback: a property with no
    coordinates is invisible to ST_DWithin but still matches its suburb by name.
  - Radius is now genuinely optional. No radius in the URL means no circle, rather than
    defaulting to 5 km. The dropdown reads "Pakenham, VIC 3810 only" / "+ within 10 km".
  - `AddressAutocomplete` gained a controlled mode (`value`/`onChange`); the listing form's
    suburb field is now a picker that fills suburb, state and postcode together, with the
    composed line shown back as a hint.
- Verified live: "Bondi Beach" alone → 2; + 6 km → 3. **The case that was broken:** suburb
  "Bondi Beach" with a 1 km circle around Paddington returns 3 — the circle alone finds only
  Paddington, and both Bondi listings 4.5 km outside it are kept. Wrong state → 0. The
  Pakenham draft stays invisible.
- New test file `search-location.test.ts` renders the where-clause through `PgDialect` and
  asserts the SQL, because both wrong versions of this return listings — just the wrong set,
  and a live-data test would pass on a database whose suburbs are all smaller than the radius.
- typecheck 9/9 · lint 9/9 · tests 97/97 · both apps build.

## 2026-09-23 — Listing edit/delete, and location becomes real

- Goal: finish listing edit + delete; make location, search and filtering work properly;
  clear the small mess. Photos stay deferred (no R2 keys).
- **Listings**
  - `updateListing` (listing:edit) and `deleteListing` (new `listing:delete`, admin-only).
    Delete is refused for live / under_offer / sold — withdraw first, and a sold listing is
    the agency's record of the sale. The property row is never deleted (#1).
  - Address matching and agent attachment were duplicated inside `createListing`; both are
    now `property-resolver.ts` and `listing-agents.ts`, shared with update.
  - `getListingForEdit` returns the full editable shape. Edit pages on both surfaces.
    `ListingForm` takes `initial` and switches mode; status is not a field it can touch.
  - Table gains Edit and a two-click Delete. `canDelete` is computed by `can()` on the
    server and passed in — the component never looks at a role (#2).
- **Location** (see ADR 0007)
  - Migration 0005/0006: lat/lng/place_id/geocoded_at/geocode_source, `place_cache`, and
    `property.geom` as a GENERATED geography column with a GiST index. `geom_wkt` dropped.
  - `packages/core/src/geo/`: `GeoProvider` port, Google adapter, db-backed cache.
  - Address autocomplete in the listing form and the agent territory step (console server
    action); location autocomplete + radius + beds/baths/cars/type/price/sort on the
    consumer search, through a rate-limited route handler.
  - Radius search with `ST_DWithin`, distance returned and shown, nearest-first ordering.
- **Fixed on the way**
  - `suburb` was ANDed into a radius search, so "within 6 km of Bondi Beach" excluded
    Paddington 4.5 km away. It is now only the fallback for unpinned listings.
  - Rent price filters read `price_from`; rentals do not set it. They now read `rent_pw`.
  - `apps/console/.../auth/callback/route.ts` imported `@supabase/*` directly. Moved to
    `@repo/auth/callback`; no app imports Supabase any more.
  - AI page named "Bondi Prestige Group" and ranked it against invented competitors with
    invented market share. Gone; the page now says no market data is connected and carries
    a "preview only" banner.
  - Client bundle: `listing-form.tsx` imported the `@repo/core/listings` barrel, which
    reaches the database client — the production build failed on `Can't resolve 'fs'`.
    `ListingForEdit` moved to `listing-schema.ts`; the form imports the schema entry.
- Verified: typecheck 9/9 · lint 9/9 · tests 91/91 (72 before) · both apps build.
  Live DB: radius 1 km → 2 Bondi listings, 6 km → adds Paddington at 4.47 km, 6 km + 3 beds
  → 1. Same over HTTP on the running dev server. New console routes 307 to login when
  signed out.
- NOT done: `/login` "Register an Agency" was already fixed (STATUS.md was stale). The DB
  still holds 4 demo listings and one junk row — every delete from a script was refused by
  the sandbox, so they need the console's own Delete button or a permission rule.

### Later the same day — the key arrived
- It had been pasted into `.env.example`, which is the committed template. Moved to
  `.env.local` (gitignored) and the template blanked. Never committed, so nothing leaked —
  `git log -- .env.example` is empty and the file is still untracked.
- **Two generations of the Places API exist** and they are separate products in the Google
  console, listed as "Places API" and "Places API (New)". On this key: Geocoding OK, Places
  (legacy) OK, Places (New) 403 `SERVICE_DISABLED` — and the error names project
  `703563155093`, while the console screenshot showing "API Enabled" was project "QuoteMy AI".
  Likely a different project, not a propagation delay (still failing after ~15 minutes).
- Rather than make that a support problem, `provider-google.ts` now asks Places (New) first
  and falls back to the legacy autocomplete, and `resolve()` falls back to Geocoding by
  `place_id` — a different product, so it is usually on when Places is not. Verified live:
  suburb and street autocomplete both return results, and a picked suggestion resolves to
  full address components plus coordinates.
- **Resolved.** The console screenshot's OAuth client ids (`795078746989-…`) gave QuoteMy AI's
  project number, confirming the key was from a different project. A new key issued from
  QuoteMy AI, restricted to Places API (New) + Geocoding API, application restriction None.
  Verified: Places (New) OK, Geocoding OK, legacy now refused by the key's own restrictions —
  which is the intended result, not a regression. Address parts parse correctly including
  subpremise (`4/4 Hall St` → unit 4, number 4, Hall Street).
  The legacy fallback in `provider-google.ts` is no longer exercised. It stays: it is what
  makes the adapter work on a project with only the old Places API enabled, which is the
  ordinary mistake.
- `apps/*/.env.local` are **symlinks** to the root `.env.local`. Next's dev watcher does not
  see a change made through the symlink, so a dev server started before the key was added
  keeps running without it — which is why HTTP still showed the local fallback while a fresh
  process worked. Restart is the fix; nothing in the code.
- `packages/core/src/geo/backfill.ts` + `pnpm --filter @repo/core geo:backfill`. It lives in
  @repo/core, not @repo/db: it needs the geocoder, and core already depends on db — the other
  direction is a cycle. (`db:geocode` was added to @repo/db first and reverted for that reason.)
- All 5 demo properties re-geocoded from the hand-placed pins, which were up to ~600 m out.
- Verified with real coordinates: Bondi Junction 1 km → 0 results, 3 km → both Bondi Beach
  listings at 1.47 / 1.66 km, 6 km → adds Paddington at 3.32 km. Same over HTTP, and the
  distance label renders on the cards. This is the case suburb-name search could never serve:
  a buyer at Bondi Junction finding listings 1.5 km away in a different suburb.

## 2026-09-22 — Shell paints before the database answers

- Goal: two complaints — data refetching on every navigation, and no shimmer on a first visit.
- Found: `(agency)/layout.tsx` and `(agent)/layout.tsx` both `await requireConsoleAccess()`, which
  awaits `loadActorContext()` — a round trip to Seoul. The layout sits ABOVE the `loading.tsx`
  Suspense boundary, so the skeleton could not render until the query returned. The screen was
  blank for the whole trip, then shell + shimmer + content arrived together.
- Done:
  - `requireConsoleSession()` — headers only, no network. The layout uses it and paints at once.
  - `loadConsoleChrome()` returns a promise the layout does NOT await; `AgencyShell`/`AgentShell`
    read it with React 19 `use()` behind three Suspense boundaries (brand, profile role, ticker).
  - `AgencyGate`/`AgentGate` — server components inside Suspense that await `requireConsoleAccess()`.
    can() still decides and children still render only after it passes.
  - `loadActorContext` wrapped in `cache()` so the gate and the chrome share one query, not two.
  - `staleTimes.dynamic` 30 → 120 in console; added to web, which had no client cache at all.
  - `.shimmerLine` in both shell CSS modules, matching PageSkeleton's animation.
- Verified: typecheck clean, lint 9/9, 72 tests pass, console production build succeeds.
- NOT verified: the visual result. Confirming the shimmer needs a signed-in browser.
- Risks / watch: the gate's `redirect()` now fires after the shell has flushed, so the no-membership
  (`/get-started`) and wrong-surface (agent on the agency host) redirects became client-side
  navigations rather than HTTP 307s. They still work; test both paths in a browser.
- Dev server must be restarted for the `next.config.ts` staleTimes change to take effect.

# Session log

Newest entries on top. Keep roughly the last 10–15; archive older notes to `docs/memory/`.

## 2026-09-22 — Claude Code — Navigation latency measured and cut; optimistic state
- Goal: the console felt slow next to a plain React SPA. Find the actual cause instead of guessing
- Measured with a real session against the live DB, not by inspection. An **empty 10-line stub page**
  took 1537 ms before any of its own work:
  `middleware getUser 609ms` + `layout getUser 521ms` (the same answer, twice) + `loadActorContext 407ms`.
  React's own render was ~30 ms — state management was never the cause
- Fixed:
  - `requireConsoleAccess` now trusts the headers middleware already sets instead of calling getUser
    again. **Found a real hole doing it:** middleware set `x-console-user-id` only `if (user)` and never
    cleared it, so a client-supplied id would have survived for an anonymous request. It is now deleted
    first and set only after verification
  - Independent queries run together: `listAgencyAgents` and `listAgencyInvites` each did two sequential
    round trips (~190 ms apiece) over the same two tables
  - Agent names are sub-selected into the listings query instead of a follow-up keyed by listing id
  - `loading.tsx` on both console groups and on web — most of the "slow" feeling was a frozen screen,
    not the elapsed time
  - `useOptimistic` for publish/withdraw and `useTransition` for the listing form and invite resend
  - eslint now ignores `.next-*/**` (throwaway dist dirs were being linted: 2700 false findings)
  - Wizard defaults no longer pre-fill a Bondi Beach territory and a Prestige specialty on every agent
- Results (server time, same pages): `/settings` 671→478 ms, `/team` 1516→890 ms, `/live-listings`
  1490→850 ms. Production build: `/settings` 0.65 s, `/team` 1.05 s. The remaining ~650 ms is one
  getUser plus one query to Seoul — co-locating app and DB in Sydney takes that to ~250 ms
- Files: packages/auth/src/middleware.ts, apps/console/lib/{require-console-access,load-actor}.ts,
  packages/core/src/team/{list-agents,manage-invites}.ts, packages/core/src/listings/{list,search}-listings.ts,
  apps/console/components/{listing-table,listing-form,page-skeleton}.tsx,
  apps/console/app/{(agency),(agent)}/loading.tsx, apps/web/app/loading.tsx, packages/eslint-config/next.mjs
- Decisions: Next stays. A property portal needs SSR for SEO and server-side `can()`; a SPA would move
  authorization into the browser. The latency was network, and a SPA pays the same round trip to
  Supabase — it just shows a shell while it waits, which `loading.tsx` now does too
- Left unfinished (exact next step): consumer search results could be cached with `revalidate`; the
  remaining getUser in middleware is unavoidable without trusting the cookie unverified
- Risks / watch: `useOptimistic` reverts on transition end, so a failed publish silently returns the row
  to its real status — the error toast is what tells the user, and it must not be removed

## 2026-09-22 — Claude Code — Agents & Team made fully dynamic; migration 0004
- Goal: verify every field the 5-step onboarding wizard collects actually reaches the database and the
  screen, and remove the hardcoded mock data around it
- Found and fixed: `firstName` / `lastName` were never stored separately — only folded into `user.name`.
  Migration 0004 adds `agent_profile.first_name` / `last_name`; `materialiseAgent` writes them
- Done: `AgencyAgentRow` widened to the whole profile (bio, licence class/expiry, territory radius,
  languages, both commission splits, permission flags, public flag, joined date); the pending-invite
  branch fills the same shape from the wizard draft; team drawer became a grouped dossier with a
  60-day licence-expiry warning; stock avatar replaced by initials; agency name and header counts now
  come from SQL in the same query as the session; fabricated market ticker removed
- Files: packages/db/src/schema.ts + drizzle/0004_*.sql, packages/core/src/team/{invite-agent,list-agents}.ts,
  apps/console/lib/{load-actor,require-console-access}.ts,
  apps/console/app/{(agency)/{layout,agency-shell,team/team-directory}.tsx,(agent)/{layout,agent-shell}.tsx,(shared)/auth-shell.tsx},
  apps/*/package.json (dev → NEXT_DIST_DIR=.next-dev)
- Decisions: agency name reaches the chrome through the existing membership query rather than a second
  round trip; header counts are scalar sub-selects for the same reason; no fabricated figures anywhere
- Verified: live probe invited an agent with all 18 fields populated, read the directory while the invite
  was pending, claimed it, read again — every field present in both states; rows removed afterwards.
  typecheck 9/9, tests 72/72, lint 9/9, build 2/2
- Left unfinished (exact next step): `/login` copy still says "Agency OS" / "Register an Agency" on the
  agent host; `(agency)/ai/page.tsx` is still mock
- Risks / watch: no edit UI for an agent profile yet — the wizard is the only way in; photos still need R2

## 2026-09-22 — Claude Code — Invite flow finished; auth email links; listings end-to-end; pool reuse
- Goal: make the agent invite actually claimable, then let agencies and agents add listings that show
  on the consumer site, and stop the console feeling laggy
- Done:
  - Invite: middleware keeps `?invite=`; `/signup` splits live/expired/accepted/revoked; token survives
    into `/login`; claim links built from `NEXT_PUBLIC_AGENT_URL`; pending-invites panel with countdown,
    copy and resend (`listAgencyInvites`, `resendAgentInvite`, `peekAgentInvite`)
  - Auth email: added `(shared)/auth/callback` (PKCE `code` → session) and `(shared)/reset/update`.
    Neither existed, so every recovery link was a dead end
  - Listings: `packages/core/src/listings/*` (contract, create, list, search, publish) + `listing:create`;
    shared `ListingForm` / `ListingTable` on both console surfaces; `apps/web` home + `/search` + `/listing/[id]`
  - Perf: `getDb` pool memoisation; `loadActor` split from `loadListingActor`
  - `copyText()` helper — the old copy button reported success where `navigator.clipboard` is absent
- Files: packages/db/src/client.ts, packages/core/src/{permissions.ts,listings/*,team/{invite-agent,manage-invites}.ts},
  apps/console/{middleware.ts,lib/*,components/{listing-form,listing-table,toast}.tsx,app/(shared)/*,app/(agency)/*,app/(agent)/*},
  apps/web/{app/*,components/*,lib/db.ts}, apps/*/next.config.ts, docs/STATUS.md
- Decisions: listings always start as `draft` (#7); `price_display` and `price_from/to` both stored and the
  string never parsed (#6); property is reused when the address repeats (#1); one form component shared by
  both surfaces rather than one per route group
- Bugs found by our own tests/probes, not reported:
  - `setListingStatus` passed `actor.agencyId` as the resource, so `sameAgency()` compared the actor with
    itself and the check always passed — scoping was really the SQL `WHERE`, and refusals surfaced as
    "not found". Now the listing is read first and `can()` is asked about *its* agency
  - `resendAgentInvite` only checked invite status, so a lapsed row whose person had joined via another
    invite could be re-issued a live link. Membership is now checked too
  - `/auth/callback` first used `request.nextUrl.origin`, which reports the server's address, not the
    requested host — redirects left `agency.lvh.me` for `localhost`
- Verified: typecheck 9/9, tests 72/72, lint 9/9, build 2/2; live DB lifecycle (draft hidden → publish →
  searchable → property reuse) and live HTTP on both apps
- Left unfinished (exact next step): hardcoded "Bondi Prestige Group" / "Agency OS" labels should come from
  the DB and the host surface; then the agent desk beyond /listings
- Risks / watch: 4 demo listings are sitting in the live DB; no photos until R2 credentials exist; the two
  `getUser()` hops per navigation are the remaining latency and touching them has a header-spoofing nuance
- My own mistakes this session, for the record: twice broke the running dev server by starting a second one
  (and once `pnpm build`) against the same `.next`. `NEXT_DIST_DIR` now exists so it cannot recur

## 2026-09-21 — Claude Code — Admin vs agent roster; invite link made claimable
- Goal: Owner must not appear as an agent; Add Agent must produce a link the agent can actually use
- Done: `isAgencyAdminRole()` exported from permissions (role knowledge stays in one place);
  `AgencyAgentRow.isAgencyAdmin`; team directory splits an "Agency admins" strip from the sales roster
  and counts only agents in tabs/KPIs; dispatch no longer calls the auth provisioner
- Files: packages/core/src/{permissions.ts,index.ts,team/list-agents.ts},
  apps/console/app/(agency)/team/{team-directory.tsx,actions.ts,onboarding/dispatch/page.tsx}, docs/STATUS
- Decisions: wizard steps unchanged (user's call); owner/admin are team, not roster; no auth
  pre-provisioning on invite
- Verified against the live agency: Saad listed as admin with 0 agents → invite dispatched (pending) →
  real Supabase signUp from the claim link → claim activated membership → directory showed 1 admin +
  1 agent (Daniel Vance, Bondi Beach/Tamarama) → test rows removed, roster back to just Saad
- Left unfinished (exact next step): browser pass of Add Agent wizard on agency.lvh.me:3001/team
- Risks / watch: no revoke/resend/suspend actions yet; invite links are shared manually (no RESEND key)

## 2026-09-21 — Claude Code — Proper auth from scratch + demo wipe
- Goal: Delete demo data, build real auth entry path, keep Add-Agent wired to the DB
- Done: ADR 0006; `pnpm db:reset` guarded wipe script (auth.users untouched); migration 0003
  (unique index membership(user_id,agency_id), unique user.email); `packages/core/identity/ensureAppUser`
  mirrors auth.users → public.user; `packages/core/agency/registerAgency` writes agency+office+user+owner
  membership in one transaction with zod contract; `/get-started` page + form; `syncAccountAction` /
  `registerAgencyAction` read identity from the session; login/signup forms updated; membership + agent_profile
  writes in invite claim made idempotent; seed.ts rewritten to demo listings for an existing agency
- Files: docs/adr/0006, packages/db/{src/reset.ts,src/seed.ts,src/schema.ts,drizzle/0003_membership_unique.sql},
  packages/core/{identity,agency}/*, packages/core/src/team/invite-agent.ts, apps/console/lib/{auth-account.ts,
  require-console-access.ts}, apps/console/app/(shared)/{account-actions.ts,get-started/*,login,signup},
  apps/console/app/(agency)/team/actions.ts, apps/console/app/(agency)/live-listings/page.tsx, .env.example
- Decisions: self-serve agency registration (not invite-only); "Confirm email" off in dev; identity never
  accepted as a client argument; seed never invents users
- Security fix: `claimAgentInviteAction` took `userId`/`email` from the browser — any caller could mint a
  membership for another account. Removed; the claim now matches the session user's own email only.
- Left unfinished (exact next step): Turn off "Confirm email" in the Supabase dashboard, sign up at
  agency.lvh.me:3001/signup, register an agency, then run the Add Agent wizard and confirm the row lands in /team
- Build fix: `onboarding-state.tsx` and `review/page.tsx` (client) imported `TIER_SPLITS` from the
  `@repo/core/team` barrel, which re-exports db-backed functions — webpack pulled `postgres` into the
  browser bundle and `pnpm build` failed on fs/net/tls/perf_hooks. Added client-safe subpath
  `@repo/core/team/schema` (zod contract only) and rewired the three client imports. Build green.
- Risks / watch: 0001/0002 had no drizzle snapshots, so `db:generate` re-emits their statements — 0003 was
  hand-trimmed and its snapshot is now correct; team directory has no revoke/suspend actions yet;
  client components must import `@repo/core/team/schema`, never the `@repo/core/team` barrel

## 2026-09-21 — Cursor — DB migrate + seed
- Goal: Apply migrations and seed after password set
- Done: DIRECT_URL fixed to session pooler (db.*.supabase.co ENOTFOUND); migrate 0000–0002 OK; seed wrote org/listings with placeholder UUIDs (no auth users)
- Files: .env.local (DIRECT_URL), docs/STATUS
- Decisions: Use pooler :5432 as DIRECT_URL when direct host DNS fails
- Left unfinished (exact next step): Paste SUPABASE_SERVICE_ROLE_KEY then re-run db:seed for DemoPass123! auth users
- Risks / watch: Seed UUIDs won't match auth until service-role re-seed

## 2026-09-21 — Cursor — Agent add onboarding → database
- Goal: Wire Add Agent wizard with real backend storage (not Stitch mock)
- Done: Extended `agent_profile` (licence, territory, commission, permissions); new `agent_invite` table + migration `0002_agent_onboarding`; `@repo/core/team` inviteAgent/claimAgentInvite/listAgencyAgents + zod + can() tests; console server actions; wizard state (sessionStorage) across 5 steps; dispatch writes invite; team directory loads DB roster; signup/login claim invite; ADR 0005
- Files: packages/db/schema+drizzle/0002, packages/core/team/*, apps/console/team/**, signup/login, docs/adr/0005, STATUS|SESSION
- Decisions: Invite-first (JSONB draft); service-role optional provision; claim on signup/login when no service role; AuthZ only via can(team:manage)
- Left unfinished (exact next step): User must put real DB password + service role in .env.local, migrate + seed, then test `/team/onboarding` → `/team`
- Risks / watch: Without DATABASE_URL password, team page shows error banner and dispatch fails; principal signup still does not auto-create agency (separate flow)

## 2026-09-21 — Cursor — Wire real console authentication
- Goal: Turn off UI preview; enforce Supabase session + can() on console
- Done: `NEXT_PUBLIC_UI_PREVIEW=0` (.env.local + example); middleware protects private routes and bounces signed-in users off login/signup; login/signup/sign-out already on Supabase, reset now uses `resetPasswordForEmail`; agency/agent layouts call `requireConsoleAccess` (getUser + loadActor + can); removed Sarah Jenkins hardcoded profile; added `console:agency` / `console:agent` actions + tests; team + finance layouts gate via `team:manage` / `agency:billing`
- Files: .env.local, .env.example, apps/console/middleware.ts, lib/require-console-access.ts, (agency|agent)/layout + shells, (shared)/login|reset, (agency)/team|finance/layout, packages/core/permissions(+test), docs/STATUS|SESSION
- Decisions: Surface AuthZ via new can() actions (not raw role checks); React `cache()` on requireConsoleAccess for nested layouts; agents denied on agency host → redirect to NEXT_PUBLIC_AGENT_URL
- Left unfinished (exact next step): Replace YOUR_PASSWORD in DATABASE_URL, set SUPABASE_SERVICE_ROLE_KEY, run db seed, then sign in as seeded owner/agent
- Risks / watch: Without DB password, login succeeds then redirects to `/login?error=database`; signup creates auth user but not membership (can() will deny until invite/onboarding wires); restart `next dev` to pick up env

## 2026-09-20 — Cursor — Instant soft navigation (layout cache)
- Goal: Stop layout re-fetch / refresh feel on every sidebar tab
- Done: Removed `await headers()` from agency+agent layouts (static shell); middleware comment — single `updateSession` getUser only; native `<Link prefetch>` (dropped preventDefault/useTransition dim); agency `loading.tsx` is the pending fallback
- Files: apps/console/app/(agency)/layout.tsx, agency-shell.tsx, (agent)/layout.tsx, agent-shell.tsx, middleware.ts, docs/STATUS|SESSION
- Decisions: Profile label is static mock until auth wire; UI_PREVIEW banner from env only
- Left unfinished: Wire real user label without making layout dynamic (client profile chip later)
- Risks / watch: Restart `next dev` if layout still feels dynamic from old cache

## 2026-09-20 — Cursor — SPA-feel nav polish
- Goal: Reduce App Router click lag (preview + cache + pending UI)
- Done: UI_PREVIEW skips Supabase in middleware; `experimental.staleTimes` 30s dynamic; sidebar prefetch + useTransition push; top progress bar + content dim while pending
- Files: apps/console/middleware.ts, next.config.ts, agency-shell*, agent-shell*
- Note: Restart `next dev` so next.config staleTimes applies
- Left unfinished: Turn UI_PREVIEW off before real auth demos
- Risks / watch: staleTimes caches RSC payloads briefly — fine for UI mock

## 2026-09-20 — Cursor — Agent onboarding wizard (Stitch steps)
- Goal: Proper multi-step Add Agent flow from Stitch screens (hardcoded)
- Done: Shared WizardChrome 5-step; identity, territory+splits, permissions, executive review, digital pass/dispatch, governance board; Team CTA → /team/onboarding; all routes 200
- Flow: /team/onboarding → territory → permissions → review → dispatch (+ governance side path) → /team
- Files: apps/console/app/(agency)/team/onboarding/*
- Left unfinished: Wire real invite/auth later
- Risks / watch: none

## 2026-09-20 — Cursor — Team directory Stitch as-is
- Goal: Rebuild Agents & Team Performance Directory to match Stitch (hardcoded)
- Done: Full page — KPIs, tabs, 4-agent table, Daniel entity drawer, compliance banner; avatars in public/stitch/avatars; used cached HTML same screen id
- Files touched: apps/console/app/(agency)/team/*, agency-shell.module.css content:has full-bleed
- Left unfinished: Fresh fetch from project 11881435632227604948 blocked by key policy (same screen id used)
- Risks / watch: none

## 2026-09-20 — Cursor — Nav performance (middleware + loading + layout)
- Goal: Fix laggy App Router navigation in console
- Done: `updateSession` returns `{response,user}` (one getUser); console middleware no second call; agency `loading.tsx` skeleton; agency/agent layouts read `x-console-user-*` headers only (no getUser/loadActor)
- Files touched: packages/auth/src/middleware.ts, apps/console/middleware.ts, (agency)/layout+loading, (agent)/layout, docs/STATUS|SESSION
- Decisions: Auth gate stays in middleware; can()/DB checks deferred out of layout for UI-first speed
- Left unfinished: Optional skip Supabase entirely when UI_PREVIEW; prod build feel check
- Risks / watch: Page-level can() still needed before real admin actions

## 2026-09-20 — Cursor — Full agency Stitch screen set (UI mock)
- Goal: Download all Stitch Agency OS screens; implement remaining agency UI pages
- Done: 13 screens HTML+PNG in `apps/console/public/stitch`; pages for team, live-listings, ai, onboarding wizard (5 steps)+governance, password reset; nav wired; design-system stub not in list_screens
- Files touched: apps/console/app/(agency)/*, (shared)/reset, middleware, docs/STATUS|SESSION
- Decisions: Agency listings URL = `/live-listings` (avoid clash with agent `/listings`); confirm screens → review/dispatch/governance
- Left unfinished (exact next step): Visual polish / motion vs Stitch screenshots; then backend wire
- Risks / watch: UI_PREVIEW still on; Stitch key exposed historically — rotate

## 2026-09-20 — Cursor — Agency Overview home + surface shells
- Goal: Stitch Agency Overview as home; clear agency / agent / client UI division
- Done: `(agency)/overview` Command Centre; `AgencyShell` (sidebar+topbar); `AgentShell` (dark desk); middleware `/`→`/overview`; UI_PREVIEW bypass; surface-boundaries skill updated
- Files touched: apps/console/app/(agency)/*, (agent)/agent-shell*, middleware.ts, docs/STATUS|SESSION|architecture, .env.example, surface-boundaries skill
- Decisions: Three chrome shells; shared core only in packages/ui+core; agency home = /overview not /team
- Left unfinished (exact next step): Next agency Stitch screen (Team directory or Listings) under AgencyShell
- Risks / watch: Turn off NEXT_PUBLIC_UI_PREVIEW=1 before real auth demos; DB password still placeholder

## 2026-09-20 — Cursor — Build order → agency first
- Goal: Correct build order — agency UI before agent
- Done: STATUS/SESSION/README updated; Sign In treated as Agency OS surface
- Files touched: docs/STATUS.md, docs/SESSION.md, README.md
- Decisions: 1) Agency `(agency)` UI → 2) Agent `(agent)` UI → 3) Consumer web; UI-first per surface
- Left unfinished (exact next step): Next agency Stitch screen (Overview or Team directory) into `apps/console/app/(agency)/`
- Risks / watch: Don’t start agent listings UI until agency flow is satisfied

## 2026-09-20 — Cursor — Build order + Stitch MCP
- Goal: Lock UI-first build order; wire Google Stitch MCP locally
- Done: MCP stitch config; later corrected to agency-first
- Files touched: docs/STATUS.md, docs/SESSION.md, .cursor/mcp.json*, README.md
- Decisions: UI-first; Stitch for demos
- Left unfinished: agency screens
- Risks / watch: mcp.json gitignored; rotate exposed keys

## 2026-09-20 — Cursor — M0 foundation (schema + Supabase Auth)
- Goal: M0 — Drizzle schema, Supabase Auth, can(), seed, RLS
- Done: Auth pivot; schema; can()+tests; auth SSR; login middleware; migrations
- Files touched: packages/{db,core,auth,config}, apps/console, docs/*
- Decisions: Supabase Auth; Seoul=dev
- Left unfinished: migrate/seed needs DB password
- Risks / watch: DIRECT_URL + service role for seed

## 2026-09-20 — Cursor — Day-1 bootstrap complete
- Goal: Master Plan v2 Day-1 — docs, agent layer, bootable monorepo, host routing
- Done: Full tree; 8 skills; AGENTS/CLAUDE symlinks; packages stubs; web:3000 + console:3001 with agents/agency host surfaces; typecheck green
- Files touched: apps/*, packages/*, docs/*, AGENTS.md, .cursor/*, .agents/skills, root tooling
- Decisions: 3 domains / 2 apps; white-label assumed No for Day-1
- Left unfinished (exact next step): M0
- Risks / watch: white-label; region

## 2026-09-20 — Cursor — Day-1 bootstrap start
- Goal: Master Plan v2 Day-1 start
- Done: Started
- Files touched: docs/*, AGENTS.md
- Decisions: 3 domains / 2 apps
- Left unfinished: bootstrap
- Risks / watch: —
