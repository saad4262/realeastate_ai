# Status — 2026-11-09 (Claude Code, Mac)

Short on purpose: where things stand now. History is in `docs/SESSION.md` and `docs/archive/`; how to work on either laptop is
`docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
`main` = ADR 0087 part 1 (an agent's own Twilio), ADR 0088 (three kinds of chat) and ADR 0089 (automations), pushed 2026-11-09 on the user's go, so Vercel deploys it.
Before that, `main` held everything through ADR 0086. The sites run on their `vercel.app` addresses; the cutover to `findoraaus.com.au` waits on DNS.

## Database
**One database: `xjklpoyxcvnlhjlxasmv`. It is production, and `.env.local` points at it.** No separate dev database yet.
96 migrations (0000–0095), all applied 2026-11-09 on the user's go: 0093 and 0094 by hand first (additive), then `db:migrate` for 0092,
which drops two unique constraints for partial ones, and 0095 (two new tables). **Do not run `db:reset` or `pnpm smoke` locally while `.env.local` points here.**

## Vercel
Applied: `AI_DAILY_BUDGET_USD=20` on all 4, `REVALIDATE_SECRET` on Agent, Web's addresses on `vercel.app`. Removed: admin credentials, `SMOKE_ENABLED`, debug variables,
`ZOOM_OAUTH_RETURN_BASE` except on Agent (remove it at cutover). Domains attached and verified in Vercel, but `misconfigured` until DNS answers.
- **To set (the user):** `ASSISTANT_OVERVIEW_READ_ONLY=1` on Agency and Agent when Overview should only read. Off, Overview is as before.
  Locally it is on, in the root `.env.local` (`apps/console/.env.local` links to it).

## DNS (checked 10:34 UTC)
The registry delegates to `haley` and `garret`, and those two serve **no A records for the apex and NXDOMAIN for `www`, `agency`, `agents`, `admin`**. The SOA serial has not moved.
Authoritative servers do not wait for propagation, so waiting may not fix this: check the Cloudflare zone first. **Switch nothing until all five addresses load over HTTPS.**

## ADR 0089: skills and automations (merged, on `main`)
A skill is what the platform provides; an automation is what a person sets up with it. A repeating bulk email or text is approved once from its chat and runs on the minute tick (`recurring/`). Skills → Automations lists everything set up, whatever it is underneath; the top bar's Skills opens to each skill's automations and chats, and Automations shows only what is running or just ran. Bulk email, AI email drafts and Workflow emails are one Email card and chat; Bulk SMS and Workflow texts one SMS card and chat; their parts keep their own switches, and chats saved under the old names open as the combined one.
Checks: unit core 2207 / AI 458, typecheck, lint, both builds. NOT done: a browser run of TEST-PLAN CX56–CX68, a live model, the new SQL on a real database, a real text. **From this push the deployed cron runs every active automation at its time, with real sends.** `WorkflowsPage` (the old tab and its library) is unused and left in place.

## ADR 0088: three kinds of chat (merged, on `main`)
Overview (read-only behind the flag above, with a button into the right chat), eleven skill chats opened from Skills (each its own tools,
switch and face; enforced on the server, not by the prompt), and a floating Help window with no tools and no history. Also: two top-bar
panels, Skills (what is on, its switch and chat) and Automations (running with progress, failed, on, paused, with Stop, Pause and Off; TEST-PLAN CX50–CX55 not run, its SQL not yet run on a real database), `usageFor`, `ai_run.chat_scope` and cached tokens, the
assistant by chat on the admin's AI cost page, and Bulk SMS by chat.
Checks: unit core 2116 / AI 458, typecheck, lint, both builds; 100+ guards broken on purpose and red. The user tested in a browser:
Bulk email chat, the help window, the bolt panel, Skills. NOT done: smoke (typechecked only), a live-model run, TEST-PLAN CX1–CX49 in full.
**Watch CX40:** with the flag on, an old chat is replayed with tools it no longer has. Unverified on a live model.
Phase 8 (per-chat limits) is not built: the user is to give numbers, or keep today's caps.

## The user's decisions, 2026-11-06
Domain `findoraaus.com.au`. Brand LocalAgentHub. Public API and webhooks: version 2. REAXML: skip for launch, CSV. Sentry: yes. Visual Search: off until real photos.
Meaning-based search: off (`EMBEDDINGS_PROVIDER` unset). Zoning: VIC, NSW, SA. AI: $20 a day. Alpha's listings are test data.
For now, while testing (the user): the sender stays on the old domain and the test Resend account is not touched; test listings stay live; sign-up stays without email confirmation.
Revisit all three before real customers: the sender name and postal address are placeholders.

## Merged: ADR 0087 part 1, an agent's own Twilio
On `main` with ADR 0088. Part 2, the office line, is not built. TEST-PLAN CW1–CW11 not run (needs live Twilio credentials).

## Blocked
- DNS: the records above. Then the switch: `docs/DNS-CUTOVER.md` sections 5, 6 and 7, and the Supabase Site URL.
- Sentry: needs the user's Sentry project; the four variables are on neither Vercel nor `.env.local`.
- Twilio: Test Credentials cannot connect or test real traffic (SESSION). Real tests need live credentials with an approved AU bundle.
- The client: SMS rules, Control Centre 4.6/4.7, triggers 4.4, Microsoft Entra, brand colours, legal details, real listings.

## Next
1. The user: set `ASSISTANT_OVERVIEW_READ_ONLY=1` on Vercel when ready; run TEST-PLAN CX, CX40 first.
2. Limits (the user's numbers, still open): today's are 50 emails per agent and 200 per agency a day, so a large repeating send stops at them. Phase 8 per-chat limits after the AI cost page shows real use.
3. DNS cutover (`docs/DNS-CUTOVER.md`), Sentry project, a separate dev database, real phone tests.

## Watch
- ADR 0083, before real customers: Listing activity names signed-in viewers to agencies, and the privacy policy does not say so yet. The user parked this for testing only.
- Stamp duty and permit rules: re-check every 1 July. SA zones: reload at most fortnightly (`pnpm --filter @repo/db db:zones`).
- Do not import `@sentry/nextjs` in browser code; use `lib/browser-monitoring.ts` (37 kB).
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
