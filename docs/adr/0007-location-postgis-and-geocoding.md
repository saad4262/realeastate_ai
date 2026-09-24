# ADR 0007 — Location: a generated PostGIS column, and a swappable geocoder

## Context
PostGIS and pgvector were installed in migration 0001 and then never used. `property`
carried `geom_wkt text` with the comment "until PostGIS geography column is wired in a
follow-up" — nothing wrote it, and "within 5 km" cannot be asked of a string. Consumer
search matched on suburb name only, so a buyer looking around Bondi Junction was shown
nothing in Bondi Beach 1.5 km away. Agent territories were free text, so "Bondi Bech"
silently matched no listing.

Separately, the rental price filter read `price_from` / `price_to`, which rentals do not
set — "up to $900 per week" was being matched against sale prices.

## Decision
- **`property.latitude` / `longitude`** (numeric 9,6) are the stored fact. **`property.geom`**
  is `geography(Point,4326)` **GENERATED ALWAYS … STORED** from them, indexed with GiST.
  Postgres maintains it; nothing writes it. It is deliberately **absent from the Drizzle
  schema** — Drizzle has no geography type, and a hand-modelled duplicate would be a second
  place for a location to live and would tempt the next `drizzle-kit generate` into
  rewriting a column Postgres owns. Queries reference it as raw SQL through one constant.
- **`packages/core/src/geo/`** defines a `GeoProvider` port (`suggest` / `resolve`) with a
  Google adapter (Places API New + Geocoding). Google is today's answer, not the contract.
- **`place_cache`** stores every resolved lookup keyed by the normalised query. Providers
  bill per call and a consumer refining a search re-resolves the same suburb repeatedly.
- **One server-side key, `GOOGLE_MAPS_API_KEY`.** Autocomplete is proxied — a console server
  action behind the session, a rate-limited route handler on the public site — so the key
  never reaches a browser and no `NEXT_PUBLIC_` variant exists.
- **Degrades instead of failing.** With no key, suggestions fall back to the suburbs already
  in the database and search falls back to matching a suburb by name. A radius search also
  keeps unpinned listings in the named suburb, so a not-yet-geocoded database returns
  results rather than nothing.
- Price bounds read `rent_pw` for rent/leased and `price_from`/`price_to` otherwise.
  `price_display` is still never parsed (non-negotiable #6).

## Alternatives
- **Browser key with HTTP-referrer restriction** — rejected; a referrer header is trivially
  forged, so the restriction is decoration, and the quota is then spendable by anyone who
  reads the page source.
- **Two columns and a separate point, both written by the app** — rejected; two copies of one
  fact that drift the first time an address is corrected.
- **Haversine in SQL over lat/lng** — rejected; unindexable, so every search becomes a full
  scan plus trigonometry.
- **GNAF (the free Australian address file)** — not rejected, deferred. It is the better
  long-term answer for Australian addresses and is exactly what the port exists to allow.

## Consequences
A listing whose address the geocoder cannot find still saves; it is simply invisible to
distance search until someone pins it. The rate limit on the public endpoint is per
instance and is a ceiling on accidental cost, not a security control — the cache is what
makes repeated queries free. Radius search needs `near` **and** the property to be
geocoded, so a backfill is needed for listings created before this.
