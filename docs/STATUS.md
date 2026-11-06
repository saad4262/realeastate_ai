# Status — 2026-11-06 (Claude Code, Mac)

Short on purpose: where things stand now. History is in `docs/SESSION.md` and `docs/archive/`; how to work on either laptop is
`docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
`main` = `f595a47`, deployed on all four Vercel projects: all 21 consumer skills, the consoles, open-home entry (ADR 0081), Sentry code (ADR 0082, off without a DSN).
The sites run on their `vercel.app` addresses. The cutover to `findoraaus.com.au` waits on DNS. Local-only `feat/crm-visibility` and `feat/crm-assistant-more`: keep or delete (the user).

## Database
**One database: `xjklpoyxcvnlhjlxasmv`. It is production, and `.env.local` points at it.** The user cancelled the separate new project: no migrations, buckets or seed.
92 migrations (0000–0091). **Do not run `db:reset` or `pnpm smoke` locally while `.env.local` points here.** A separate dev database is still to be made.
Test data: all 41 listings are test. 38 of them (Alpha 26, Harbour 6, Yarra 3, Sunshine 3) are to be withdrawn, not deleted. **Not applied yet:** the write was blocked by
Claude Code's permission check, and the user decides how to run it (see SESSION). Phone Test's 3 stay, for the domain and phone checks. No test agency or account is deleted.

## Vercel
Applied: `AI_DAILY_BUDGET_USD=20` on all 4, `REVALIDATE_SECRET` on Agent, Web's addresses on `vercel.app`. Removed: admin credentials, `SMOKE_ENABLED`, debug variables,
`ZOOM_OAUTH_RETURN_BASE` except on Agent (remove it at cutover). Domains attached and verified in Vercel, but `misconfigured` until DNS answers.

## DNS (checked 10:34 UTC)
The registry delegates to `haley` and `garret`, and those two serve **no A records for the apex and NXDOMAIN for `www`, `agency`, `agents`, `admin`**. The SOA serial has not moved.
Authoritative servers do not wait for propagation, so waiting may not fix this: check the Cloudflare zone first. **Switch nothing until all five addresses load over HTTPS.**

## Checks
Unit core 1856 / ai 426, typecheck 10/10, lint 0 errors, both builds. Live on `f595a47`: 9 public pages 200, consoles redirect to login, revalidate without secret 401, 0 error logs.
The user reports the user, agent and agency sides tested in a browser. Not confirmed: the admin side, the Open homes tab, Agent revalidation in use, the AI budget in use.
Only testable after the switch: real email links, Google and Zoom connect.

## The user's decisions, 2026-11-06
Domain `findoraaus.com.au`. Brand LocalAgentHub. Public API and webhooks: version 2. REAXML: skip for launch, CSV. Sentry: yes. Visual Search: off until real photos.
Meaning-based search: off (`EMBEDDINGS_PROVIDER` unset). Zoning: VIC, NSW, SA. AI: $20 a day. Alpha's listings are test data.

## Blocked
- DNS: the records above. Then the switch: `docs/DNS-CUTOVER.md` sections 5, 6 and 7, and the Supabase Site URL.
- Sentry: needs the user's Sentry project; the four variables are on neither Vercel nor `.env.local`.
- Twilio: Test Credentials cannot connect or test real traffic (SESSION). Real tests need live credentials with an approved AU bundle.
- The client: SMS rules, Control Centre 4.6/4.7, triggers 4.4, Microsoft Entra, brand colours, legal details, real listings.

## Next
1. The user: the go for the test-listing withdrawal; fix the Cloudflare zone; create the Sentry project.
2. After HTTPS passes: switch Vercel's addresses and `COOKIE_DOMAIN`, rebuild all four, then section 6 services and section 7 checks. Tell agencies they sign in again once.
3. After those checks: withdraw Phone Test's two live listings and decide on deleting the three test agencies and their accounts.
4. Real phone tests, one real end-to-end run, and a separate dev database.

## Watch
- Stamp duty and permit rules: re-check every 1 July. SA zones: reload at most fortnightly (`pnpm --filter @repo/db db:zones`).
- Do not import `@sentry/nextjs` in browser code; use `lib/browser-monitoring.ts` (37 kB).
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
