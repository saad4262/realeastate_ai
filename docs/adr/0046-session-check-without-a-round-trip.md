# 0046 — Middleware verifies the session locally (`getClaims`), not by asking Supabase (`getUser`)

**Status:** ACCEPTED and BUILT, 2026-10-16 (the user: "ADR 0046 par kaam shuru kar do"), branch `feat/session-claims`.
Follows the region fix (`49eca64`, functions in `syd1`).

## Problem

`updateSession` (packages/auth/src/middleware.ts) calls `supabase.auth.getUser()` on every
request the console's matcher covers — every page, every RSC navigation, every prefetch,
every Server Action POST. `getUser()` is a network call to Supabase Auth (Sydney). Middleware
runs at Vercel's edge near the visitor, not in `syd1`, so the region fix does not shorten it:
from Australia it is small, from anywhere else it is one long round trip before the page's
own work starts. `apps/web` already keeps it off its fast routes for this reason (its matcher).

## Decision

1. In `updateSession`, replace `getUser()` with `getClaims()`. Verified 2026-10-16 against the
   Supabase Next.js SSR guide ("Always use `supabase.auth.getClaims()` to protect pages";
   "never trust `getSession()`") and the installed auth-js 2.116 source:
   - it reads the session via `getSession()`, which **refreshes an expired one** — the cookie
     refresh middleware exists for keeps working;
   - with an asymmetric key it **verifies the signature locally** (WebCrypto) against the
     project's JWKS, cached module-wide for 10 minutes; the project publishes one ES256 key
     (checked: `/auth/v1/.well-known/jwks.json`);
   - with an HS key, or no WebCrypto, it **falls back to `getUser()`** — never weaker than today.
2. Headers come from the claims: `sub` → `x-…-id`, `email`, `user_metadata.full_name`/`name`
   → label. Same strip-then-set rule as now.
3. `getAuthAccount` (apps/console/lib/auth-account.ts) and `getUser` in packages/auth/server.ts
   stay on `getUser()`: they run on a few actions that need the live auth record (email
   change, account screens), not on every navigation.

## What gets weaker, and why that is acceptable

A session revoked elsewhere (sign out of all devices, user deleted or banned in Supabase)
keeps passing **middleware** until its access token expires (project setting, default 1 h).
It does not pass the app: every console page and action loads the actor from **our** database
(`loadActor` → membership → `can()`, CLAUDE.md #14), so a removed member (ADR 0030) is refused
at once. Signing out on the same browser clears the cookies, so it is unaffected. If that hour
is too long, shorten the JWT expiry in Supabase (e.g. 10 min) — refresh is automatic.

## Verification (before merge)

- Unit: header derivation from claims; a forged `x-console-user-id` still stripped; a token
  signed by another key refused (break-test: skip verification → red).
- Smoke: signed-in navigation keeps working across the 1 h boundary (refresh path); an expired
  cookie with no refresh token → `/login`.
- Measure: console navigation time before/after from outside Australia, recorded here.

## As built (2026-10-16)

- `updateSession` calls `getClaims()`; `identityFromClaims` turns verified claims into `{ id, email, label }`
  (`SessionResult.user` is that identity now — both apps only ever read `.id`). Header strip unchanged.
- `packages/auth` has unit tests now (`vitest`, offline guard; in `pnpm test`): real ES256 keys, a fake JWKS and refresh
  endpoint. 9 tests: identity from claims; signed by the project key → forwarded with **zero** `/auth/v1/user` calls;
  another key / edited claims / no cookie → nobody, forged `x-console-user-id` and `x-web-user-id` gone; expired →
  refreshed, new cookie, still zero `/user` calls; refresh refused → nobody.
- Break-tests, each red: trusting the cookie's token without a signature check (2 fail); back to `getUser` (4 fail);
  header strip removed (2 fail).
- Against real Supabase Auth and a local `next start`: a test owner's token is ES256 with a `kid`; `/leads`,
  `/settings/integrations` and `/api/live` answer 200 signed in; a forged id header with no cookie → 307 `/login`.
  Smoke "Console (HTTP, signed out)" 16/16. Not measured: production timing from outside Australia (TEST-PLAN AW).

