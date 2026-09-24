# ADR 0008 — Middleware headers are the session, for Server Actions too

## Context
Middleware already calls `supabase.auth.getUser()` on every request the console
serves and forwards the verified identity as `x-console-user-id`. Pages have
read that header since the layouts were split — `requireConsoleSession()` does
no I/O at all — because calling `getUser()` again in a layout was measured at
~520 ms on every page load.

Server Actions were never converted. Each one called `getAuthAccount()`, which
is that same round trip, paid again on every publish, withdraw, delete, edit,
address keystroke and pin drag. Server Action POSTs go to page routes, so the
matcher (`/((?!_next/static|_next/image|favicon.ico).*)`) already covers them
and the header is already on the request — it was simply not being read.

## Decision
`x-console-user-id` is the console's statement that **this request's session was
verified by middleware**, and Server Actions may read it like pages do.

1. Middleware deletes `x-console-user-id`, `-email` and `-label` from the
   incoming request **on every path, before any branching**, then sets its own.
2. `actionUserId()` in `apps/console/lib/auth-account.ts` reads the header, and
   falls back to `getAuthAccount()` when it is absent.
3. `listing-actions.ts` uses it. `account-actions.ts` does **not**.

## Alternatives
- **Read the header with no fallback.** Rejected: if a runtime ever stops
  forwarding rewritten request headers, every action breaks at once. The
  fallback costs a branch and fails closed identically.
- **Convert `account-actions.ts` as well.** Rejected on correctness, not
  latency. `registerAgencyAction` and `syncAccountAction` write `account.name`
  into `public.user` and the agency row, and `x-console-user-label` is not
  `user_metadata.full_name` — it falls back to the email's local part. Using it
  would quietly store different data. They also run once per account, so there
  is nothing to win.
- **Sign the header (HMAC).** Rejected as solving a problem we do not have: the
  header never leaves the server. Middleware sets it on a request object Next
  forwards in-process; it is not a cookie and not a response header.

## Consequences
- Authentication is unchanged. Middleware performs the same real token
  verification; this only stops asking a second time for an answer it has.
- Authorisation is unchanged. `loadListingActor()` + `can()` still decide, and
  they query by this id — an id outside the actor's agency returns nothing.
- **The strip is now load-bearing, and it was not complete.** Two paths reached
  a Server Component without `updateSession` ever running, and both forwarded
  the caller's own headers intact: `NEXT_PUBLIC_UI_PREVIEW=1` returns before
  calling it, and `updateSession` throws inside `publicEnv()` — *before* its own
  delete — when a Supabase env var is missing, which middleware's `catch`
  swallows. A typo in `NEXT_PUBLIC_SUPABASE_URL` should cost the console its
  sessions, not hand out impersonation. Hence the unconditional strip at the
  top.
- `pnpm smoke` asserts a forged header carrying a **real** member's id is still
  sent to `/login`. Status alone cannot show this — stripped is a 307 to
  `/login`, trusted is a 307 to `/get-started` — so the check reads the
  destination.
- If a deployment ever fails to forward rewritten request headers, the fallback
  keeps the console working at the old latency, and logs a warning in
  development rather than failing silently.
