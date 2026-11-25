# 0099: Several suburbs in one search, each with its own surrounds

**Status:** accepted 2026-11-24 (the user approved `docs/mocks/home-search.html`, all decisions as recommended; Build tab option A).

- **What.** The search box takes up to 10 places, shown as chips. The results are listings in ANY of them.
  The Distance control adds "within N km" around **each** place, so the area is a union of circles, each also taking its whole suburb by name (the same union a single suburb + radius already is).
- **URL.** `loc=Pakenham|VIC|3810` repeats, one per place. `suburb=` still works, and a link, saved search or alert from before is read exactly as before.
  One `loc` and no `suburb` becomes `suburb`/`state`/`postcode` (`normalisePlaces`), so a one-place search goes down the path every reader already understands. `type=` may also repeat (`propertyTypes`).
- **Centres.** Each place's centre is looked up on the server (`place_cache`), as for `suburb=`. The browser's coordinates are never used for a named place.
  If a place cannot be geocoded, it keeps its name match and loses only its circle.
- **Saved searches and alerts.** `savedSearchQuerySchema` gains optional `places[]` (max 10) and `propertyTypes[]`. Both are stored in the existing JSON, so there is no migration.
  `toRuntimeQuery` resolves every place's centre in parallel, before any transaction.
- **Not done.** Results are not sorted by distance when there are several centres: that order would mean "nearest to which one?". The default order is newest.
  Travel time ("10 mins walk") is not offered, because we have no such data; the box suggests "within 2 km" instead.
- **Amended 2026-11-25: a distance per place.** The user picked "10 km Pakenham" and "20 km Perth" and expected both.
  - `loc` takes an optional fourth part, the km around that place: `Pakenham|VIC|3810|10`. A place's own km wins over
    the shared `radius`, so old links still read.
  - Each chip has its own distance select. The Distance control sets every suburb at once, and says "Different per
    suburb" when they differ.
  - /search, /sold, saved searches and alerts honour each place's km.
