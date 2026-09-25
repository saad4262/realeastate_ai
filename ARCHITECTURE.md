# ARCHITECTURE.md

The standing rules for this repo: how it renders, fetches, caches, navigates
and validates, and what it refuses to do.

`CLAUDE.md` holds the non-negotiables — domain rules that make this a property
platform rather than a CRUD app. This file holds the engineering rules that
keep it fast and keep it honest. Both apply. Where a rule below has a number in
it, that number was measured in this repo, not copied from a blog post.

**How to use this file.** Before adding a page, a component, a query or an
endpoint, find the matching section. If what you are about to do contradicts
it, you have two options: do it the way the rule says, or change the rule here
in the same commit and say why. Silently doing it differently is how the thing
the rule prevents comes back.

---

## 1. The shape of it

```
apps/web       public consumer    site.com.au
apps/console   agent + agency     agents.* -> (agent), agency.* -> (agency)
packages/db    Drizzle schema, the one source of types
packages/core  business logic and data access
packages/auth  Supabase Auth SSR
packages/ai    every LLM call, without exception
packages/ui    plain React, shared by both apps
packages/smoke live invariant checks
```

Two apps, three domains, one database, one packages layer. `agents.*` and
`agency.*` are the same app; never fork them.

**`packages/ui` has no framework dependency, and that is deliberate.** It
imports React and nothing else. When it needs something framework-shaped — a
client-side link, a router — the app hands it in. `AppShell` takes `linkAs`
rather than importing `next/link`. Keep it that way; a shared package that
imports Next is a shared package that can only ever be used by Next.

---

## 2. Rendering: Server Components are the default

A component is a Server Component unless it cannot be. `'use client'` is a
budget, not a convenience.

**What earns `'use client'`:** browser APIs (`window`, `IntersectionObserver`),
event handlers that cannot be a form or a link, `useState` that genuinely
cannot live in the URL, or a third-party widget that needs the DOM.

**What does not:** wanting to use `.map()`. Wanting a nicer import. "It was
easier."

### Two styling systems, and which is which

`apps/web` has Tailwind. `apps/console` and `packages/ui` have CSS Modules.
That is a real cost — two ways to do one thing — so the line is drawn once,
here, rather than per file:

| Where | Use |
|---|---|
| `apps/web` pages and components | Tailwind utilities |
| `apps/console` | CSS Modules |
| `packages/ui` | CSS Modules — it is shared, and has no build step of its own |
| Anything needing a real stylesheet feature (`@media` inside a component, keyframes, `::after` overlays) | a CSS Module, in either app |

Two things make it survivable:

- **Tailwind runs WITHOUT preflight.** `apps/web/app/tailwind.css` imports the
  theme and utilities layers by hand and skips base. Importing `tailwindcss`
  whole would drop its reset under every page that was built on browser
  defaults plus `packages/ui/styles.css`. The two things preflight is wanted
  for — border-box and a zeroed body margin — `styles.css` already does.
- **`@theme static`, not `@theme`.** Tailwind only emits the variables its
  generated utilities use. The CSS Modules still styling most of this app read
  the same tokens as plain custom properties, so a token nothing happened to
  use as a class would simply not exist for them. `static` emits the set, and
  that is the only reason "one source, two systems" is true rather than
  aspirational. A CSS Module may write `var(--color-ink-soft)` and get exactly
  what `text-ink-soft` resolves to.

**Tokens are structure from the mock, values from this site.** The Stitch mock
is cool slate; this site is warm. Taking its palette would have left `/search`
and `/listing` looking like a different product from `/` and `/chat`, which
share a token file with the console.

**No CSS may name a font weight `layout.tsx` does not load.** Six rules set
`font-weight: 700` while only 400 and 600 were loaded, so every price on the
site was faux-bold. Check the generated `@font-face` before assuming a weight
exists — and note that these are variable fonts, so an extra weight usually
costs zero bytes. Measure it; do not assume either way.

### Icons

`apps/web` currently ships none, and that is worth keeping. When it needs
them: inline SVG, not an icon font. The Stitch mock's `<link>` requests
Material Symbols across its full variable axis space — the exact 4.0 MB →
1.1 MB regression § 11 records — so copying that tag verbatim would undo the
largest single win in this repo. If Material Symbols is wanted anyway the axes
must be pinned (`@20..24,400,0..1,0`), and it is a whole font on the critical
path of a site that today loads no icons at all.

### The island rule

When a mostly-static component needs one interactive control, extract the
control, not the component. Keep the page a Server Component and give it a
small client island.

Measured in this repo:

| Change | Before | After |
|---|---|---|
| Console shells → Server Components, nav extracted | 9,574 B | 4,783 B (−50%) |
| `/ai` page → Server Component + composer island | 4.72 kB | 1.71 kB (−64%) |
| `/team` directory → URL state, tabs become links | 7.14 kB | 4.4 kB (−38%) |

### `usePathname` cannot move to the server

Layouts are preserved across client navigation and do not re-render. A
server-computed "active" class goes stale the moment someone navigates. Active
nav state is one of the few things that genuinely must be a client island.

### Lazy-load anything that cannot server-render

```tsx
const MapView = dynamic(() => import('@repo/ui/maps').then((m) => m.MapView), {
  ssr: false,
});
```

Rendering a component conditionally is **not** code splitting — the module
ships either way. Maps went from a static import to this and took 29% off
`/search` and 26% off `/listing/[id]`.

---

## 3. Navigation: never hand back a full page load

**Every internal link is `next/link`.** A raw `<a href="/...">` is a new HTML
request, the whole client bundle parsed again, every layout torn down, scroll
position gone.

This is the easiest rule in the file to break by accident and the hardest to
notice in review — the markup is identical, the page still works, it is just
three hundred milliseconds slower. It has been broken here once already, in the
site header, which is the most-clicked control on the public site.

If a shared package needs to link, it takes a link component as a prop.
`apps/web` routes every page through `WebShell` so `next/link` is supplied in
exactly one place.

### Links that open a new tab

A `target="_blank"` link is not a client-side navigation. Next bypasses its
router for any `target` other than `_self`, so `next/link` and a raw `<a>` emit
identical DOM here and the rule above has nothing to say about it.

Use `next/link` anyway. The reason is social rather than technical: this rule is
the easiest one here to break by accident, and a raw `<a href="/search…">` in
this repo should be a thing a reviewer stops on. An exception that looks exactly
like the mistake is not worth the two characters it saves.

Three things go with it, every time:

- **`prefetch={false}`.** Prefetching a dynamic route would run the work once in
  this tab and again in the tab it opens. The chat's handover to `/search` is
  exactly that shape.
- **`rel="noopener"`** — the security half. Not `noreferrer`, which additionally
  strips the `Referer` and throws away same-site attribution for no benefit on a
  first-party link.
- **An `aria-label` that says where it goes and that it opens a new tab.** A
  decorative `↗` is `aria-hidden` and announces nothing on its own.

### Prefetching is targeted, never blanket

- **Do not** prefetch a list of routes in a `useEffect` on mount. The console
  sidebar did; it fired twelve full route prefetches on every page load.
- **Do** let `next/link` viewport-prefetch the primary nav. Those routes have
  `loading.tsx`, so what is prefetched is the skeleton — cheap, and it makes
  the transition instant.
- **Do** prefetch on intent for large grids: one delegated client island
  around the grid (`PrefetchOnIntent`), so the cards stay Server Components.
  There is deliberately no mouse-out handler — a prefetch already in flight is
  cheaper to finish than to cancel and repeat.

---

## 4. State: the URL is the state store

There is no Zustand, no Redux, no global store, and none is needed. Before
reaching for one, work through this in order:

1. **Does it belong in the URL?** Filters, sorting, pagination, tabs, the
   selected row — all of it. It survives refresh, Back, Forward and being sent
   to someone. `/team` moved `tab` and `selectedId` into `?tab=`/`?agent=` and
   lost 38% of its JavaScript doing it.
2. **Is it server data?** Then it is not client state. Fetch it on the server;
   do not mirror it into `useState`.
3. **Is it one component's ephemeral UI?** `useState`, locally. Fine.
4. **Is it genuinely shared, client-only, and not URL-shaped?** Only now
   consider a store — and write an ADR first.

### Do not mirror the URL into state

The search bar held eleven `useState` values mirroring the query string, and
they drifted out of sync with it. It is now a real GET form: uncontrolled
inputs with `defaultValue` from the URL, keyed on `params.toString()` so a
navigation remounts it. Desync is structurally impossible rather than
carefully avoided — and the search works with JavaScript disabled.

---

## 5. Data fetching

**Fetch on the server. Pass data down. Do not fetch in an effect.**

- **Start independent work together.** `const a = slowThing(); const b =
  otherThing(); await a; await b;` — not two sequential awaits. The search page
  had a waterfall where the filter options blocked the results.
- **`await` inside the Suspense boundary that should show the fallback.**
  Awaiting above the boundary blocks the whole page and the boundary never
  shows.
- **Key Suspense boundaries on the query, not the raw params.** `key={JSON
  .stringify(query)}` — two different URLs that mean the same search should not
  remount.
- **Select only what the page renders.** The search list carried every
  listing's `description` — up to 20,000 characters each, 48 per page, for a
  card that never shows it. `PublicListingSummary` and `PublicListing` are
  separate types for this reason.
- **One statement per read.** Sub-select related rows; use window functions for
  totals and counts. `query-count.test.ts` holds the numbers and will tell you
  when you have added a round trip.

### Counts and totals come from SQL, never from `rows.length`

A count computed in the browser forces the query to return every row. This is
what kept the console's listing query unpaginated: two header figures were
being counted client-side, so the whole agency book had to be shipped to
render twenty-five of them.

```sql
count(*) over()                                as total
count(*) filter (where status = 'live') over() as live
```

Window functions are evaluated before `LIMIT`, so these stay set-wide.

**Coerce them.** `count()` is `bigint` and the driver returns `bigint` as a
**string**, so a count typed `number` arrives as `"3"`. TypeScript cannot catch
it — the type is a lie the query wrote. Left alone it reaches the console's
optimistic counter as `"3" + 1` and publishing a listing makes the header read
`Live 31`. `Number()` at the boundary, every time.

### Pagination

Offset-based, through the URL, `?page=` and 1-based. Validate it: a page number
is the only user input that widens a query, and `Number('2.5')` reaching
`.offset()` is how you get `offset NaN`.

**Every ordering needs a unique tiebreaker.** `created_at` is not unique. A
page boundary landing inside a group of rows sharing a timestamp repeats one
row on this page and skips another on the next. Append the id to every
`ORDER BY`.

---

## 6. Caching and revalidation

Four layers, and you should know which one you are touching:

| Layer | What | Controlled by |
|---|---|---|
| Data Cache | `unstable_cache`, tag-invalidated | `lib/cached.ts` |
| Full Route Cache | ISR | `export const revalidate` |
| Router Cache | client-side, per navigation | `experimental.staleTimes` |
| Request dedupe | per-request memo | React `cache()` |

**The invariant:** the router cache window must be ≤ the Data Cache TTL of the
data on that page. `staleTimes.dynamic` is 30 because `cachedSearch` is 30. If
you change one, change the other, and say so in both places.

**Cross-app invalidation is explicit.** The console and the public site are
separate processes; the console's `revalidatePath` cannot reach the web app's
cache. Publishing calls `revalidateWeb()` → `POST /api/revalidate` (shared
secret) → `revalidateTag`. Anything that writes listings outside the console —
a script, a migration, a backfill — must bust the cache the same way, or the
public site stays wrong until a timer says otherwise.

**`unstable_cache` serialises to JSON.** Every `Date` that goes into it comes
out an ISO **string**, while the type still says `Date`. Nothing caught this
for months because nothing rendered a date; the first thing that did died on
`publishedAt.getTime is not a function`. Revive at the cache boundary, where
the lie is created — not by teaching consumers to accept `Date | string`,
which spreads the boundary through the app.

This is the third shape of one bug in this repo: a value whose runtime type
does not match its declared one, at a boundary TypeScript cannot see across.
`count()` returns bigint as a string. `numeric` columns come back as strings.
Dates through a cache come back as strings. **Coerce at the edge, and write a
test that asserts the type and not just the value** — `expect(typeof x).toBe('number')`
is what catches these, because `"3" == 3` and `"3" + 1` both look fine until
they do not.

**ISR needs `generateStaticParams`, even returning `[]`.** Without it a dynamic
route never enters `dynamicRoutes` in the prerender manifest and every request
re-renders, whatever `revalidate` says. This is not a build-time hint; it is
required.

**Do not cache a route that can return the wrong HTTP status.** `/listing/[id]`
is deliberately `force-dynamic` even though caching it was measured working end
to end, because `notFound()` answers with HTTP 200 in production. A wrong
status served fresh is a bug; a wrong status served from a cache sticks.

---

## 7. Forms and validation

**One schema, enforced on the server, reused on the client.** The listing form
imports the same zod schema the server action enforces, so a bad draft never
costs a round trip to come back as an error. The server never trusts the client
having done it.

### Validation rules are about shape, not taste

Every rule must be something you can state precisely and defend. "The headline
is badly written" is not a rule. "The headline is one word" is.

The rules that exist, and what they caught:

| Rule | Caught |
|---|---|
| Headline ≥ 10 chars and more than one word | `"dfs"`, `"jdsfjdfjl"` |
| Display price contains a letter or `$` | `"9320334343324"` |
| Room counts ≤ 20 | 23 bedrooms, 32 bathrooms |
| A sale listing carries a price | silent "Contact agent" |
| Property type from a fixed vocabulary | `"sfd"`, `"2jkads"` |

### A filterable dimension is never free text

If the UI filters on a column, or builds a dropdown from its distinct values,
that column needs a controlled vocabulary. `property_type` was free text and
the public search was offering buyers `"2jkads"` as a property type, with
`"House"` and `"house"` counted as different kinds of building.

One list, in `packages/core`, exported — the same rule as `AU_STATES`, and the
same reasoning as non-negotiable #8.

### Tighten the rule and repair the rows in the same change

Old rows were legal when they were written. Two things make that safe:

- **A smoke check that asks the real schema** of what is in the database, not a
  second copy of the rules that can drift from it.
- **A repair script** under one rule: every repair is **derived from something
  true** or is an **honest NULL**. Never invent a value. `db:repair-listings`
  builds `"3-bedroom house in Pakenham"` out of the property row, and nulls a
  bedroom count it knows is wrong rather than guessing a right one.

  Its first draft produced `"3-bedroom sfd in Nar Nar Goon North"`, because it
  trusted `property_type` while it was in the middle of repairing
  `property_type`. A repair is only as good as the field it reads.

---

## 8. Writing to the database

- Multi-step writes go in `db.transaction`. Helpers that write take `DbOrTx`,
  never `Db`.
- Network calls (geocoding) happen **before** the transaction opens. Never
  inside one.
- Reads have a known query count. One extra query per row is an N+1 and
  `query-count.test.ts` will say so.

---

## 9. Auth and permissions

- Every permission decision is `can(actor, action, resource)`. Never
  `if (user.role === ...)`. Every new endpoint gets a permission test.
- **Middleware headers are the session** inside Server Actions
  (`docs/adr/0008`). `requireActionUserId()` reads the verified header rather
  than re-running `getUser()` — that re-check was ~520 ms on every publish,
  edit and delete.
- **Middleware strips those headers unconditionally, before any branching.** It
  is the second line of defence, and it has mattered: a forged
  `x-console-user-id` rendered a real owner's agency console, HTTP 200, through
  two paths that reached Server Components without the strip running.
- **A public endpoint has no actor, so its authorisation is what the server
  decides rather than accepts.** The enquiry form is the worked example: the
  browser chooses the listing id and nothing else, the agency is looked up from
  that listing, the listing must be live, and status/kind/assignment are set in
  `packages/core`. Accepting an agency id would file leads into anyone's inbox;
  accepting a draft id would confirm that the draft exists.
- **Rate limit every public write**, and say honestly in the comment that an
  in-process counter is a ceiling on accidental volume, not a security control.
- Hiding a button is a courtesy. The server refuses regardless.

---

## 10. Loading and error boundaries

- **Every route that queries the database gets a `loading.tsx`.** It renders
  that page's own chrome — header, shell, skeleton in the shape of the real
  content — so the transition is a fill, not a flash.
- **No root `app/loading.tsx`.** It replaces the whole shell, header included,
  and reads as a full reload because visually it is one.
- Skeletons are built to the same measurements as the real component. A
  skeleton of the wrong height is a layout shift with extra steps.
- Console errors render **inside** the shell so the sidebar survives. A bare
  error page reads as "the site is down".

---

## 11. Performance budgets

Current, from `next build`. Treat a regression as a bug with a cause.

| Route | Page JS | First Load |
|---|---|---|
| web shared | — | 103 kB |
| `/` | 446 B | 125 kB |
| `/search` | 1.66 kB | 126 kB |
| `/listing/[id]` | 2.64 kB | 109 kB |
| `/chat` | 8.1 kB | 114 kB |
| console shared | — | 103 kB |
| `/team` | 4.4 kB | 111 kB |
| listing form routes | 138 B | 126 kB |

`/listing/[id]` grew four times its content and still costs 109 kB, because
all of it is Server Components. The one client island on it — the enquiry form
— deliberately does **not** import the zod schema the server validates with:
that cost 13 kB of First Load JS to save a round trip on a four-field form most
visitors never open. The console's listing form makes the opposite trade, and
should: it is behind a login, it has twenty fields, and it is the tool of
someone's job.

**Look outside JavaScript first.** The single largest win in this repo was not
a bundle. Material Symbols was requested across its full variable axis space
while every rule in the codebase uses one weight:

```
@20..48,100..700,0..1,-50..200   4,001,724 bytes
@20..24,400,0..1,0               1,107,100 bytes   (−2.9 MB, render-blocking)
```

Fonts are self-hosted through `next/font`. There are zero third-party font
requests on the public site.

---

## 12. Verification

From `CLAUDE.md`, and it is the most important rule in either file:

> **Break the thing a new check guards and confirm it goes red before trusting
> it.**

This is not ceremony. In this repo, found by doing it:

- Two radius checks could not detect the bug they guarded — `wide >= suburbOnly`
  is satisfied by equality.
- Three speed checks silently stopped working when `loading.tsx` was added:
  they timed to first byte, and a streamed shell flushes at the same speed
  cached or not. "Cold 33 ms, warm 33 ms" looked fine while the cache was gone.
  They now read the full body and assert an absolute budget, because even the
  ratio passed with the cache ripped out.
- A `#4` violation alarm was a bug in the check, not the model.
- **A model swap broke `/chat` completely while 99 unit tests stayed green.**
  `output_config: { effort }` and `thinking: { type: 'adaptive' }` are rejected
  with HTTP 400 by a model that does not implement them, and Haiku 4.5
  implements neither. Every test either called `getModel` — happy to report an
  `effort` nobody can send — or used a fake client, which accepts any params at
  all. Nothing built a request and looked at it. The guard added is an assertion
  on the recorded request body, not on the config.


**"It renders" is not "it renders correctly."** A page can return 200, contain
every word it should, pass every assertion here, and still be unstyled blue
links — Tailwind only emits a class it finds, so a PostCSS step that is not
running produces exactly that. It happened: a dev server started before
`postcss.config.mjs` existed served the whole redesign with no utilities, and a
phase of "does the page render" checks that only grepped for text never noticed.
`pnpm smoke` now compares the classes a page's markup uses against the CSS that
page actually serves.

**Restart the dev server when build configuration changes.** PostCSS and
`next.config.ts` are read at startup; a running server will not pick them up,
and it will keep serving a stale build that looks like a code bug. `.next-dev`
is worth deleting at the same time.

**Routine verification is free and offline.** `pnpm test` runs with `fetch`
blocked, and a test that tries to reach an http(s) URL fails naming it. The
smoke suite's AI group is gated on `SMOKE_LIVE_AI=1`, not on whether a key
exists — a key in `.env.local` is not consent to spend it. `pnpm smoke:ai` is
the command that costs money, and it is run on purpose.

That gate used to be `Boolean(process.env.ANTHROPIC_API_KEY)`, so every run of
the command you are told to run after every change spent about US$0.02. Over
one session it drained the balance to zero, and six checks then went red for a
billing reason rather than a code one — which is the worst kind of red, because
it teaches you to ignore the output.

**A new invariant belongs in `pnpm smoke`.** A new endpoint needs a permission
test. A projected win is not a win: measure before and after, and when the
projection turns out wrong, say so and drop it. Phase 5d's planned 60% cut of
the listing form did not exist — the fields it called inert all read client
state.

Order: `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm smoke` →
`docs/TEST-PLAN.md` for anything needing a browser.

---

### A model parameter is a capability of the id, not a preference of the route

`packages/ai/src/models.ts` holds a `CAPABILITIES` table beside `PRICES`, and
`getModel` omits any parameter the chosen model does not accept. The pipeline
spreads those keys conditionally and **must never supply a fallback** — a
`?? 'medium'` there is exactly the 400 the table exists to prevent. An
unrecognised id is treated as accepting nothing, because omitting a parameter
costs some answer quality while sending a rejected one costs the whole turn.

Both `PRICES` and `CAPABILITIES` are keyed by **exact id**, so a model is
configured by its alias (`claude-haiku-4-5`), never a dated snapshot
(`claude-haiku-4-5-20251001`) — the snapshot is unpriced, and `costUsd` returns
0 for an unknown id rather than throwing, so it would write $0 into every
`ai_run` row while the chat carried on working. The API resolves the alias to a
snapshot in its *response*; `ai_run` records the id we **sent**, deliberately.

Adding a model means adding a row to both tables and re-running the capability
check against the live API. It is four 1-token requests and costs under a cent.

## 13. Adding something new — the checklist

1. Read `docs/STATUS.md` and the top of `docs/SESSION.md`.
2. Write the types and zod schema first. Derive types from
   `packages/db/schema.ts`; never hand-write a duplicate.
3. Business logic goes in `packages/core`. If two route groups need it, it
   belongs there — not in `apps/`.
4. Server Component by default. Justify every `'use client'`.
5. State goes in the URL unless you can say why it cannot.
6. `next/link` for every internal link.
7. One query per read. Counts from SQL. A unique tiebreaker on every ordering.
8. `loading.tsx` if it touches the database.
9. Decide the caching layer deliberately and write down the TTL relationship.
10. `can()` for every permission. A permission test for every endpoint.
11. Add the invariant to `pnpm smoke`, then break it and watch it go red.
12. Big decision? `docs/adr/NNNN-title.md` first, ten lines.

---


### Prompt caching may not be reaching Haiku

Two `ai_run` rows from one live turn on 2026-09-25 bill as if nothing was
cached: `in 4128 out 112 → $0.004688`, which is exactly
`4128/1e6 × $1 + 112/1e6 × $5`. Both `cache_creation` and `cache_read` were
therefore zero, on two requests three seconds apart, with two
`cache_control: ephemeral` breakpoints set on the system blocks.

The likely cause is that a cache breakpoint applies to the cumulative prefix and
must clear the model's minimum cacheable length, which is higher for Haiku than
for Opus. `PROPERTY_CHAT_V6` may sit under it.

**Not yet proven**, and deliberately not claimed as a regression: the older
Opus rows in `ai_run` are 91 and 246 input tokens, from a much smaller prompt,
so there is no comparable baseline. Establishing one means one turn per model
with the cache fields read from the API response rather than inferred from the
cost. Worth doing — this is most of the input cost on the route, and the whole
point of the two breakpoints.

## 14. Known gaps

Recorded so the next person does not have to rediscover them.

- **`/listing/<unknown-id>` returns HTTP 200** with the not-found body, in dev
  and in production alike. Pre-existing; reproduces on a clean build with
  `force-dynamic` and with `not-found.tsx` deleted entirely. An earlier note
  here claimed dev returned a correct 404 — re-measured against the committed
  code, it does not. The cause is streaming: the shell flushes the status line
  before the component body runs `notFound()`, so it follows the `loading.tsx`
  boundary rather than the environment. It is a soft 404 on the one page search
  engines index, and the only thing blocking ISR on that route — the caching
  itself was verified working end to end. (`docs/TEST-PLAN.md` F26.)
- **`priceDisplay` is not checked against `priceFrom`/`priceTo`.** The shape
  rule stops a bare number, but "Offers over $1.45m" alongside a range of
  $300k–$400k still saves. Checking it means parsing the string, which #6
  forbids in spirit and which is genuinely hard across `"$1.45m"`,
  `"1,450,000"` and `"high $1m's"`. A wrong parse refuses a legitimate listing,
  which is worse. Left open deliberately.
- **`router.refresh()` after a Server Action that already called
  `revalidatePath`** appears in `listing-table.tsx` and `listing-form.tsx`. It
  is very likely a duplicate round trip, and it holds `isPending` — and so
  every action button — disabled for its duration. It was left in place because
  removing it could not be verified without an authenticated console session,
  and the failure mode if the reasoning is wrong is a visibly stale table. To
  settle it: publish a listing, remove the call, confirm the row still updates.
- **`useActionState` / `useFormStatus` on the console's listing form.** Would
  give one form convention across the console. Not a speed change; the form
  cannot work without JavaScript anyway (autocomplete, pin map). High risk on
  the main data-entry path with no automated coverage of an authenticated
  submit.
- **No photos anywhere.** The `media` table exists and nothing populates it:
  no R2 credentials, no upload path. Both the card's media slot and the
  listing page's hero frame are shaped for `next/image` with `fill`, so a photo
  drops in without either layout moving — but `PublicListingSummary`
  deliberately has **no** media field yet, because a field no query populates
  is a type that lies.
- **The listing page's Tier-3 sections are honest placeholders.** Features and
  inclusions, energy rating, market insights and school catchments have no data
  source at all; market figures in particular would need an external feed, and
  inventing one is exactly what #4 forbids. They render as one muted line each
  under a heading that says so.
- **The radius-cache timing budget is tight enough to flake.** `warm < 150 ms`
  against a measured 29–55 ms hit; a loaded machine has produced 154 ms. Loosen
  it against a measurement, not against one red run.
- **Console listing search/filtering.** Pagination landed; there is no way to
  search within the book yet, which starts to matter past a few pages.
