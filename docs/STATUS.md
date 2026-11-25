# Status — 2026-11-25 (Claude Code, Mac)

Short on purpose: where things stand now. History is in `docs/SESSION.md` and `docs/archive/`. The plan and the V1 to-do list
are `docs/PLATFORM-PLAN.md` (section 14, with progress). Overwrite this file at each handoff; do not append.

## Milestone
`main` = `e9745e0`: everything through ADR 0090 (hybrid Twilio) and ADR 0091 part A (control centre), live since 2026-11-16.
V1 production-readiness: about 12% (PLATFORM-PLAN 14). Steps 0–2 nearly done; step 3 (backups) next.
Branches waiting for a PR and merge: `chore/dev-db-and-prod-guard` (production guard + 0001 extensions fix), `docs/platform-plan` (this).

## Agency data export (ADR 0101) — phases 1–3 BUILT on `feat/agency-data-export` (worktree `../realestate_ai-export`), NOT merged, 2026-11-25
Brief `docs/briefs/agency-data-export.md` (the user's decisions locked). Quick CSV on Customers (+ notes), Listings, Leads, Calendar,
Pipeline (`/api/exports/[dataset]`). Full export ("Download your data": `/settings/data` owners/admins, `/my-data` agents): migration
**0109 `export_job` — applied on DEV only (110 migrations); production NOT migrated**; the job queue's `bulk` lane (now run by the minute
tick) builds it a step a job: 13 CSVs → `data.zip` (+ README) → `photos-N.zip`, `documents-N.zip` (≤ 40 MB each) in the documents bucket
under `exports/`; bell + email; 60 s signed link per part, asker only; deleted after 24 h (hourly sweep). Any member, their screens' scope;
never a platform view; `data_exported` audit rows. New dependency: `fflate@0.8.3` (already in the lockfile) for core and smoke.
Checked: `pnpm test` (core 2544, AI 462, db 20), typecheck, lint, console AND web builds, 26 guards broken and red; smoke on dev
"Tenant isolation" 6/6 and "Data export" 1/1. **Browser, 2026-11-26: TEST-PLAN DA1–DA18 all pass** (`e2e/tests/data-export.spec.ts`,
8/8, console production build on dev): real Storage upload, signed download and 24 h deletion; the ready email through Resend
to its test inbox, `delivered`. Dev Storage left clean. NOT run: a large agency's timing. Waiting on the user: production backup,
migration 0109, merge. Privacy policy must mention export.

## Home page search like realestate.com.au (ADR 0099) — LIVE: `main` = `1d3ad71` (ADR 0099 merge `ba6ba16`, then the no-lag fix `501eb4b` + `1d3ad71`), 2026-11-25
On the user's go: production backup `prod-20261125T065102Z.dump.enc` (145 tables), migration 0108 on production (109 applied,
the column checked read-only), merge `--no-ff`, pushed; Vercel built all 4 projects. Mock `docs/mocks/home-search.html` (approved 2026-11-24; Build tab option A).
- Built: tabs Buy / Rent / Build / Sold / Address / Agents; several suburbs as chips (`loc=Suburb|STATE|pc`, up to 10) with a
  Distance around each, on `/search`, `/sold`, saved searches and alerts; "within 10 km of X" read without the AI; Filters panel;
  recent searches in the browser; AI toggle; the same box above `/search` and `/sold` results; `/address` pin-point (property
  page only where the public once saw a listing); `/agents` (counts only); "New home / off the plan" tick on the listing form
  (`listing.is_new_build`, migration **0108, on dev and production**); header Buy, Rent, Sold, New homes, Find agents.
- Checked: typecheck, lint, `pnpm test` (core 2518, AI 462), both builds, break-tests, new SQL on dev (read-only), headless Chrome
  on dev (TEST-PLAN CZ mostly). NOT run: smoke; a sold page with real sale rows (dev's sold listings have no price/date);
  the drafts-only address case against real data (unit test only).
- Still open: agents tick "New home" on real listings before the Build tab shows anything on production (0 of 43 today).
- **Sold tab Filters (brief `docs/briefs/rea-home-search-parity.md`) — LIVE: merge `d61dd3c`, all 4 Vercel builds Ready,
  checked on findoraaus.com.au.** Type (several), beds, baths, cars and a recorded sold-price range on the Sold tab and above `/sold`; kept by
  the pager, sort, "Homes for sale" (not the price) and a Clear link; the sales cache key is now the whole query. Checked:
  `pnpm test`, break-tests, full `pnpm --filter @repo/web build`, headless Chromium on dev (15/15), smoke (below).
  First-suggestion latency parked: measured, the server adds nothing a cache could remove (see SESSION).

## Databases
- **Dev:** `realestate-dev`, ref `jhialeuioqqlwpzukdzo`, Sydney, Micro. Every `.env.local` on this laptop points here. Use the pooler
  URLs (`postgres.<ref>@aws-0-ap-southeast-2.pooler.supabase.com`, 6543 and 5432): the direct `db.<ref>` host is IPv6-only and fails
  with ENOTFOUND. 109 migrations (0000–0108), census loaded, buckets `media` (public), `documents`, `inspection-photos`, platform admin
  `admin@test.com`. **No agency yet**, so `pnpm db:seed` waits for a sign-up at `localhost:3001/get-started`.
- **Production:** ref `xjklpoyxcvnlhjlxasmv`. Its values live only in Vercel (Production) and the password manager. 109 migrations
  (0108 applied 2026-11-25, after a backup and a dev run). **PITR is off** (PLATFORM-PLAN decision 7).
- **Backups:** encrypted `pg_dump` with `/Users/saadiii/Job/secure_backups/backup.sh` (key kept apart, full decrypt check). Last:
  `prod-20261125T065102Z.dump.enc`. The script reads `.env.local` (now DEV): export production's `DIRECT_URL` first. Run it before every production migration until the scheduled dump (0.4) exists.
- **The other laptop's `.env.local` still points at production.** Switch it to the dev values.
- Smoke on dev, 2026-11-17: Database & migrations, Database health, Credentials, Tenant isolation (`SMOKE_CHECK_TIMEOUT_S=900`),
  Platform admin, all green.

## Vercel
Preview and Development hold the dev Supabase values (5 keys) on all 4 projects; Production is unchanged (checked by hash). Other
preview values (`CRON_SECRET`, Retell keys) are still shared with production. Earlier: `AI_DAILY_BUDGET_USD=20` on all 4,
`REVALIDATE_SECRET` on Agent. `ASSISTANT_OVERVIEW_READ_ONLY` is no longer read; the local line can go.

## DNS (checked 2026-11-09 10:34 UTC; not rechecked since)
The registry delegates to `haley` and `garret`, and those two serve **no A records for the apex and NXDOMAIN for `www`, `agency`, `agents`, `admin`**. The SOA serial has not moved.
Authoritative servers do not wait for propagation, so waiting may not fix this: check the Cloudflare zone first. **Switch nothing until all five addresses load over HTTPS.**

## Final shape of the assistants (the user, 2026-11-10, on `main`)
The AI Assistant (Overview) does everyday work and no skill's; each skill has its own assistant (Email, SMS, Listing, Dashboard, Meetings, Team, AI Skills); Help only guides. The Daily work chat is gone: an old one opens as the AI Assistant. Clicking an automation opens its chat with a details panel on the right (or a drawer for someone else's): the run going now, what is left, its history.

## Overview is the AI Assistant (2026-11-10, on `main`)
Overview's chat looks things up and does everyday work (notes, leads, appointments, contacts, the team for owners and admins) on cards; a skill's job goes to that skill's assistant by a button. The read-only flag is gone: every new Overview chat is `general`, and so is every chat from before skills had chats. Recents names each chat's assistant. An automation one run of which would pass a daily limit is not made. **Watch CX40 on live:** old chats now run as the AI Assistant with fewer tools than they were made with.

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
0. Fix the two smoke checks that assume a small database (`paging walks the result set…`, `the page agrees with the database`).
   Search box layout fix LIVE: merge `10b4394` (layout shift 0.18 → 0 on findoraaus.com.au, 1280 and 390 px).
1. Merge `chore/dev-db-and-prod-guard`, then `docs/platform-plan`.
2. Step 3, backups: a scheduled encrypted off-site `pg_dump` with a missed-dump alert (0.4), then one restore into a scratch project.
3. Step 4, accounts and alarms (the boss): spend stops, Sentry, Upstash, 2FA; branch protection, gitleaks, Dependabot.
4. Dev: sign up an agency, then `pnpm db:seed`. The other laptop's `.env.local` to dev.
5. The user: set `ASSISTANT_OVERVIEW_READ_ONLY=1` on Vercel when ready; run TEST-PLAN CX, CX40 first.
6. Limits (the user's numbers, still open): today 50 emails per agent and 200 per agency a day. DNS cutover (`docs/DNS-CUTOVER.md`), Sentry project, real phone tests.

## Watch
- Once the guard is merged, a script against production needs `CONFIRM_PRODUCTION=xjklpoyxcvnlhjlxasmv` for that run.
- ADR 0083, before real customers: Listing activity names signed-in viewers to agencies, and the privacy policy does not say so yet. The user parked this for testing only.
- Stamp duty and permit rules: re-check every 1 July. SA zones: reload at most fortnightly (`pnpm --filter @repo/db db:zones`).
- Do not import `@sentry/nextjs` in browser code; use `lib/browser-monitoring.ts` (37 kB).
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
