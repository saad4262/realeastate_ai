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
- **Addendum, same day: what a press feels like.** The heart is drawn empty from the first paint. A press
  before the read answers waits for it. A signed-out press is remembered for ten minutes in sessionStorage and
  saved on the way back from sign-in. One toaster in `WebShell` says what happened ("Home saved · View saved",
  "Removed · Undo"); notices have their own listeners, so it never starts a read. Undo is
  `restoreToShortlist`: the note and date come back, and only for a listing that was ever published. The Saved page
  is one `useOptimistic` list: the action's re-render is the rollback. The store's tests are apps/web's first
  (`pnpm --filter @repo/web test`, offline like every package).

**Addendum (2026-11-26).** The web app has no Tailwind preflight (tailwind.css), so every `<button>`, `<p>` and heading
here carries its own reset (`border-0`, `m-0`), and widths use rem, never `max-w-sm|md` — those resolve to the spacing
tokens (0.5rem, 0.875rem) and drew the toast and the empty state one word per line in production. The heart is the
brand red. `packages/e2e/tests/saved-homes.spec.ts` drives the whole flow in a browser and guards all three.
