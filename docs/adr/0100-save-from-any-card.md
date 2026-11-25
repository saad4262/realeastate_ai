# 0100: Save a home from any card — one client store for the hearts

**Status:** accepted 2026-11-25. Builds on ADR 0080 C4 (the shortlist). ARCHITECTURE § 4 asks for an ADR before a store.

- **Why a store.** A heart now sits on every listing card (home, search, chat panel, listing page). Which homes
  this visitor saved is shared by every card on the page and is not URL-shaped, and `/`, `/search` and
  `/listing/[id]` are cached with no session, so the server cannot render it.
- **One read per page.** `apps/web/lib/saved-homes.ts` (`useSyncExternalStore`, no library) loads the visitor's
  saved ids once from `GET /api/shortlist`. That is a fetch, never a Server Action (§ 3: an action in flight eats
  the next link click). The route verifies the session itself, so the middleware matcher does not widen.
- **Never stale across pages.** When no heart is mounted, the store forgets everything, so the next page reads
  again. Sign-in by a Server Action redirect and removals on `/account/shortlist` are therefore seen without
  extra code.
- **Writes** stay the existing `setSaved` action and core's `can()`. The store toggles optimistically, rolls back
  on failure and ignores a second press on the same home while one is in flight.
- **Not done:** sync between open tabs (each page reads fresh on its own), and a count in the header.
