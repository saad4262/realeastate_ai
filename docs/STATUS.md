# Status — 2026-11-06 (Claude Code, Mac)

Short on purpose: where things stand now. History is in `docs/SESSION.md` and `docs/archive/`; how to work on either laptop is
`docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
`main` = `b22bafe`, deployed: all 21 consumer skills, the consoles. **`feat/open-homes` is uncommitted work on top of it:** open-home entry (ADR 0081) and
Sentry (ADR 0082). Not deployed until the user says commit. Local-only `feat/crm-visibility` and `feat/crm-assistant-more`: keep or delete (the user).

## Database
Two Supabase projects now. **The current one** (dev and what Vercel still points at): 92 migrations (0000–0091; 0091 applied 2026-11-06, the user's go).
**A new production project** exists, made by the user: untouched, nothing migrated or loaded, and Vercel does not point at it yet. Do not switch Vercel
before it is migrated and loaded (migrations, census, SA zones, three buckets, the first platform admin), with the user's go for each step.

## Checks
Unit core 1856 / ai 426, typecheck 10/10, lint 0 errors, both builds. Smoke "Open homes (ADR 0081)" 1/1. Break-tests in SESSION. Whole-suite smoke baseline still
not run. TEST-PLAN CR, CS and everything before it: the user, in a browser. The Open homes tab has not been clicked in a browser.

## The user's decisions, 2026-11-06
Domain `findoraaus.com.au` (nameservers moving to Cloudflare). Brand LocalAgentHub. Public API and webhooks: version 2. REAXML: skip for launch, CSV. Sentry: yes.
Visual Search: off until real photos. Zoning: VIC, NSW, SA. AI: $20 a day. Alpha's 24 listings are test data, not migrated. Their answer grouped "5 & 8" as
Visual Search; item 5 was meaning-based search (`EMBEDDINGS_PROVIDER`), still unset: confirm.

## Blocked
- Twilio: Test Credentials cannot connect or test real traffic (SESSION). Real tests need live credentials with an approved AU bundle.
- The client: SMS rules, Control Centre 4.6/4.7, triggers 4.4, Microsoft Entra, brand colours, legal details, real listings.

## Next
1. The user: commit `feat/open-homes` and merge; Sentry project and its variables.
2. The user's go, with `.env.production.local`: prepare the new database. Then Vercel's variables, the domains, then `docs/DNS-CUTOVER.md` section 6.
3. Browser walk, real phone tests, one real end-to-end run.

## Watch
- Stamp duty and permit rules: re-check every 1 July. SA zones: reload at most fortnightly (`pnpm --filter @repo/db db:zones`).
- Do not import `@sentry/nextjs` in browser code; use `lib/browser-monitoring.ts` (37 kB).
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
