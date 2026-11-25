# Brief — Home search: realestate.com.au parity (Sold Filters + smoke)

**From:** the user, via Cursor handoff, 2026-11-25  
**To:** Claude Code (next session)  
**Repo:** this worktree / `main` at `d5e031b` (home-search no-lag live)  
**Goal:** Public home search + Sold flow should feel like [realestate.com.au](https://www.realestate.com.au) for an Australian buyer — same tabs, chips, filters, results. No fluff.

## Already live (do not re-build)

- Six tabs: Buy / Rent / Build / Sold / Address / Agents  
- Multi-suburb chips + Distance (km)  
- Filters on Buy / Rent / Build  
- Instant suburb chip (no second resolve) — `suggestionToPlace`  
- Suggestion cache, abort, “Searching places…”, empty-state copy  
- Rate limit 60/min on `/api/places`  
- Lesson locked: before any web push, run **full** `pnpm --filter @repo/web build` (not lint tail)

## Do next (ordered)

### 1. Sold tab Filters — match Buy/Rent (highest priority)

realestate.com.au Sold search has property type, beds, baths, cars, price. Ours hides Filters on Sold (`home-search.tsx`: `tab !== 'sold'`).

**Facts already in code:**

- `RecentSalesQuery` already has `bedrooms` and `propertyType` and filters them in `recent-sales.ts`.  
- `/sold` page does **not** read `beds` / `type` / baths / cars / price from the URL and does **not** pass them into `cachedRecentSalesPage`.  
- Home box may already append filter params when going to `/sold`, but the Filters button is hidden on Sold.

**Build:**

1. Show the same Filters UI on the **Sold** tab (and keep it on the results bar above `/sold`).  
2. Wire `/sold` to parse `beds`, `type` (and `baths` / `cars` / `priceFrom` / `priceTo` if we support them), keep them in pager/sort links.  
3. Extend `recentSales` only where needed: if baths / cars / sold-price range are missing, add them the same way Buy search filters work (SQL on `adFacts` / `sold_price`). Prefer one type or `propertyTypes[]` consistent with `/search`.  
4. Unit tests + a break-test (filters ignored → red).  
5. Headless Chromium on live or local: Sold → Filters → beds/type → results and URL match.  
6. **No migration** unless schema truly lacks a column (beds/type already exist on ads).

### 2. Smoke

Run the relevant smoke groups for public web / `/sold` / `/search` (whatever this repo already names for portal pages). Record green/red in SESSION. Do not invent a huge new suite — extend existing smoke if a home-search invariant is missing (e.g. `/sold?beds=3&type=house` returns 200 and respects filters when data exists).

### 3. First-suggestion latency (0.8–1.8s)

Mostly Google. Do **not** pretend we beat Google. Only ship if there is a real win without new paid APIs:

- Keep “Searching places…” (done).  
- Optional: warm / longer server cache for common AU suburb prefixes; measure before/after on production-like latency.  
- If no clear win after a short spike, park it and say so.

### 4. Out of scope unless user re-asks

- Changing Distance from “within N km” to REA’s “surrounding suburbs” toggle (we already chose km).  
- Filling Build tab by faking `is_new_build` on production listings (agents must tick New home).  
- DNS / Sentry / Twilio / V1 backup schedule.

## Working rules (non-negotiable)

1. Read `docs/STATUS.md` + top of `docs/SESSION.md` + this brief first.  
2. New branch / worktree from current `main` (e.g. `feat/sold-filters-rea`).  
3. Ponytail / project skills as usual.  
4. Measure in browser (ms), not “feels faster”.  
5. Before push: full `pnpm --filter @repo/web build` + unit tests for touched packages.  
6. **Ask the user before merge / production / migrate.** Site must not rely on a failed Vercel build.  
7. After ship: overwrite STATUS, append SESSION, update this brief status to done.

## Done looks like

- Sold tab shows Filters; choosing House + 3 beds lands on `/sold?...&type=house&beds=3` and results match.  
- Same filters survive page 2 and sort.  
- Buy/Rent/Build/Address/Agents unchanged and still snappy.  
- Smoke noted; full local web build green.  
- User asked for go before live.

## Status

**Done on branch `feat/sold-filters-rea` (2026-11-25), waiting for the user's go to merge.** Items 1 and 2 done (see
SESSION 2026-11-25 night); item 3 parked with numbers: the server adds nothing a cache could remove. Smoke: the new Sold
Filters check green; two older /search checks red on dev's large data, not caused by this change.
