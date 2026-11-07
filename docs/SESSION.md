# Session log (newest on top)

Entries before 2026-10-31 (late) are in `docs/archive/SESSION-to-2026-10-31.md`. Keep this file short: when it
passes ~10 entries, move the older ones to a new archive file.

## 2026-11-07 (later) — Claude Code (Mac) — ADR 0085 no reply after 6 hours; ADR 0086 the admin's AI cost page

- The user asked what runs across agent, agency and user, then chose from my list: a shorter no-reply wait, and the AI cost page by mock first. Starter pack, open-home check-in, vendor report and seller prospecting are parked for later.
- There was no global "1 day": each workflow has its own wait, and the library's default was 2 days. Added `hours: 6` beside `days`.
- Found: the scan never saw a new enquiry, because its words are on the lead and its conversation has no message. The user wants the first enquiry caught and saved workflows untouched, so only the 6-hour wait covers it.
- AI cost: mock approved, all recommended. Found while checking: skills and the floorplan reader saved no agency (fixed from now on); the public chat and buyer tools do not check the $20 limit (shown on the page, not changed).
- Verified: 8 + 6 + 12 guards broken on purpose, each red, then restored. One stayed green at first and got a missing test case. Core 1953, AI 438, typecheck, console lint and build.
- NOT run: `pnpm smoke` (three new checks, typechecked only; `.env.local` is production), any of the new SQL on a real database (a read-only production query was refused by the permission check, and not retried another way), TEST-PLAN CU and CV in a browser.
- Pushed and merged to `main` by fast-forward on the user's go.

## 2026-11-07 — Claude Code (Mac) — ADR 0084: the same email updates the profile

- The user asked for agencies to bring old customers by CSV or by hand with four details, and for the same email to update the profile. Most of it existed (ADR 0029, ADR 0079).
- The user's two answers: a different value replaces the old one, which stays on the timeline; CSV and manual only, enquiries unchanged. My addition, in the ADR: only someone who may edit the person (`contact:update`) replaces, so one agent cannot rewrite another's customer. An empty cell erases nothing.
- Also fixed: the template had no address columns; the Import page still said an existing email is "skipped". No migration.
- Verified: core 1910, typecheck core, smoke, console, console lint and build. Seven guards broken on purpose, each red, then restored.
- NOT run: `pnpm smoke` (the two edited checks are typechecked only; `.env.local` is production), TEST-PLAN CF4, CF5, CF8, AO7 in a browser. A read-only check of the address columns on the database was blocked by the permission check; STATUS's migration count is the only evidence they are there.
- Later the same day, the user: the assistant should do this too, with name, email, phone and address required and everything else optional. The assistant already opened the import screens for contacts (`start_import`: upload, or Google Sheet connect and pick). Changed: every import row needs all four (replaces ADR 0079 §3 for the import), one Address column is split when it can be, prompt `assistant@v31` (v30 still said "skipped"). Six more guards broken on purpose, each red, then restored. Core 1915, AI 437.
- NOT seen: Google Sheet connect and pick in a real browser (STATUS: Google connect is only testable after the switch).
- Then the assistant's `create_contact` card, on the user's go: same four details, and the same path as the form, so an email already held updates that profile. Seven more guards broken on purpose, each red, then restored. Core 1929, AI 438.
- Merged to `main` by fast-forward on the user's go, without the browser test or smoke, while the product is in testing.

## 2026-11-06 — Claude Code (Mac) — ADR 0083: the full customer profile

- The user's decisions: agency sees its own listings' activity; the profile shows the customer's whole history; Messages
  built empty; Emails and SMS never mixed; privacy parked for testing (ADR 0083 says what must change before real customers).
- Mock `docs/mocks/customer-profile-full.html`, then built on the user's "mock dikhao phir code": tabs SMS, Calls,
  Messages, Activity; Enquiries reads Leads with a summary; the smart panel (fixed rules); the summary on a button; Log a
  call; Listing activity (agency, agent, admin's view of an agency); admin People, the fuller customer page, "Customer at".
  No migration.
- Verified: core and AI unit tests, typecheck, console build. Ten guards broken on purpose, each red, then restored. New
  queries run on the real database inside a `begin read only` transaction: all valid, one real view scoped right, an agent
  named on nothing saw nothing.
- NOT run: `pnpm smoke` (STATUS: not locally while `.env.local` is production), so the new smoke group "Customer profile,
  every channel" is typechecked, never run. No live model call: the summary is fake-tested only. Not seen in a browser:
  TEST-PLAN CT. Real data is thin: 1 site_activity row, 0 texts or calls tied to a contact.
- Committed on the user's go: `feat/customer-profile-full` (`04f148b`, from `main`), then pushed and merged into `main` by fast-forward on the user's go; made in a separate worktree so a parallel
  session's uncommitted `apps/web/lib/cached.ts` and `docs/STATUS.md` stayed out. These two handoff notes are not on that branch: `main` is one docs
  commit behind `feat/open-homes` in both files, so adding them there would have conflicted. They reach `main` with that docs commit.

## 2026-11-06 (later) — Claude Code (Mac) — Production preparation; cutover waits on DNS

- `feat/open-homes` merged and deployed (`f595a47`). The user cancelled the new database: `xjklpoyxcvnlhjlxasmv`, in `.env.local`, is production; nothing was migrated or loaded on it.
- Vercel variables applied and leftovers removed (STATUS). Five domains attached; DNS records given to the user. Their report says DNS is live, but `haley`, `garret`, 1.1.1.1 and
  8.8.8.8 all still serve nothing at 10:34 UTC, with an unchanged SOA serial, so no address was switched.
- Test data: all 41 listings are test, `live` and `sold` rows reach public pages. Withdrawing, not deleting: reversible, the app's own "off the public site", and search and sold figures
  exclude it. A one-off status update skips the workflow events and emails the app's path would fire. The write was blocked by Claude Code's permission check, so nothing changed; the dry run
  matched 38 of the expected 38. Phone Test's listings stay because the domain checks and phone tests need a public listing.
- Git: 29 local branches fully in `origin/main` deleted; each commit checked against `origin/main` first. Local `main` fast-forwarded 72 commits in the `realestate_ai-crm2` worktree; its uncommitted
  lockfile change (`mammoth`, `unpdf` specifiers) was discarded and is already in `origin/main`. Worktrees kept: each holds `.env.local` files that may be the only copy.
- The user then chose: leave test listings live, keep the old sender and test Resend account, keep sign-up without confirmation, for now. So the withdrawal is dropped, not pending.
- Search: 2 of 13 early fetches of `/search` had no results, then 30 of 30 were fine; cause not confirmed. Found while looking: `cachedSearch` caught a database failure inside `unstable_cache`, so it was
  stored for 30 seconds with no log. Now caught outside and logged. Typecheck and lint only; the failure path was not exercised live.
- NOT done: Sentry (no project or values); the domain switch and everything after it.

## 2026-11-06 — Claude Code (Mac) — Open homes and Sentry; launch status

- Macro review found no write path for `inspection`, test agencies on the public site, 0 photos on live listings, and only a stub Twilio
  account. Status page and go-live checklist given to the user; their answers: domain `findoraaus.com.au`, a new Supabase production
  project made, public API moved to version 2, REAXML skipped, Sentry yes, zoning VIC/NSW/SA, $20/day AI, brand LocalAgentHub, Alpha is test data.
- Open homes (ADR 0081) built on `feat/open-homes`: tab, `open_homes` import column, migration 0091 applied to the CURRENT database only (92 recorded).
  Found while building: the public card printed the server's clock (10:00 am Melbourne as 11:00 pm Friday), sold homes kept their times, and a
  Details save wiped `listing.auction_date`. All fixed. The smoke group caught a raw `Date` bound into SQL that the fake db could not.
- Sentry (ADR 0082): errors only, scrubbed in core. A top-level import cost public pages 37 kB; now loaded late, +2 kB. It also pulled a second copy
  of Next.js through `@opentelemetry/api`: pinned in auth, web and console so one copy resolves.
- Break-tests red for the right reason, then restored: overlap, clock, permission, bad import cell, email scrub, no DSN, sold home, Details wipe.
- Twilio Test Credentials checked against Twilio's docs: only buy, send, call and Lookup, no callbacks, no real traffic; our connect flow uses API keys and
  lists AU numbers, so they cannot connect. Told the user.
- NOT done: the tab clicked in a browser; anything committed; the new production database touched.

## 2026-11-04 (night) — Claude Code (Mac) — C9 Immersive in the user's autonomous loop

- C9 mock approved with the providers and committed (`b023cc2`). The session ended mid-build once; the work on disk was
  intact and the loop resumed.
- Immersive built, no migration: links stored as `provider:id` (the smoke rule that `storage_key` is never a URL kept),
  embedded by code (youtube-nocookie, Vimeo dnt, Matterport), click to play; floorplans as listing images; room names
  by a vision reader under a strict schema (C3's room types; a size refuses the answer) on the alerts cron; the import's
  three columns; the console editor (a CSS module — the console has no Tailwind); the listing section; `floorplan_rooms`
  (prompt v18). Fixed in the loop: the import's column check runs in the browser, so the pure link rules moved to
  `media/links.ts`; the template test wanted the new columns in both templates.
- Break-tests red then restored: http links allowed; the room schema loosened (a size got through); drafts shown.
- One smoke run lost to DNS (ENOTFOUND), rerun green 23/23. Live checks (the reader on `packages/smoke/fixtures/
  floorplan.png`, which prints sizes on purpose; the guide asked a bedroom's size) run with the user's consent: green
  (reader: kitchen, bathroom, bedroom, living, study, no digits; the guide named rooms, gave no size). One run lost to an
  upstream "Overloaded", rerun green.
- Development: VIC `open-data-platform:plan_zone` (WFS) and NSW Principal Planning layer 19 answer for real points; SA
  publishes only downloads and its services refuse outside queries (403).
- Immersive committed and pushed (`08c6f1d`). Development: migration 0089 applied, SA loaded (Rundle Mall → City Main
  Street, Prospect → Established Neighbourhood; 0 invalid polygons; one GiST probe). The loader stopped on the first
  real code it did not expect ("E(BH)") — its pattern now comes from the file's 65 codes. Guards that caught me: the
  tenant-isolation classification (planning_zone → shared) and ADR 0075's fact rule (land size must be the page's own
  — `lastAdFact` moved into `listings/facts.ts` and shared with the off-market page). Break-tests red then restored:
  markup let through, WA asked, "can be subdivided" not caught; the subject's second read (query count).
- Smoke "Consumer skills" 25/25 (one earlier run lost a check to DNS, rerun clean); VIC and NSW answered live in the
  shape read. Live check (the user's go): the guide called `land_and_zoning`, named GRZ1 with its source, no advice.
- Development committed and pushed (`35eaebf`, `425ada3`). Visual Search built offline: migration 0090 applied (the
  user's go), Voyage multimodal API and pricing checked against its docs (POST /v1/multimodalembeddings; $0.60 per
  billion pixels, 150B free), the embedder fake-tested only, the cron's embedding behind `VISUAL_EMBED_ENABLED`
  (off). Break-tests red then restored: the switch ignored, a score on the card, the filling-up gate skipped, the
  price filter dropped. Smoke fixes: two checks still named Visual Search as the unbuilt skill; Opportunity's
  "94 days" read 95 in Sydney's calendar near midnight across daylight saving (either accepted, with the reason).
- Smoke 26/26. Live (the user's go): Voyage embedded the floorplan fixture nearer "an architectural floor plan drawing"
  (0.414) than "a beach at sunset" (−0.028), metered in ai_run; the guide called `homes_that_look_like` and said the
  order is by how alike the photos look, no score. Backfill not run (0 public photos), by the user's decision.

## 2026-11-04 (late) — Claude Code (Mac) — C8 Acting for the buyer in the user's autonomous loop

- C7 committed and pushed (`3ebff67`, `1e61901`). C8 mock approved (all twelve) and committed (`b981657`). Migration 0088
  applied (the user's go): 89 recorded, RLS on the three tables, the existing schedule stayed an alert.
- Built: Agent AI (draft from the request's words + the listing's facts; core rejects offers, claims on the buyer's
  behalf, figures in neither source, money they did not raise, contact details → template; Send = a reply in their
  conversation or an ordinary enquiry from the account; 5 a day; "Drafted with the guide" on their copy only), Tasks
  (kind=task on the alerts' claim, which now filters by kind and needs Tasks on; seven fixed sections from SQL; a
  sentence handed no figures, rejected for digits, counting words or verdicts; once → done; empty runs skip the email),
  Automation (fixed when/then, SQL detection over shortlist and watched addresses, each event once, the action in the
  event's transaction, Undo, 8 am or hourly outside 9 pm–7 am, `a.`/`m.` unsubscribe). The guide: three draft tools,
  signed cards, prompt v17.
- Fixed in the loop: Dates passed raw into `db.execute` (the driver cannot bind them; Automation's detection swallowed
  the error as "no events") → ISO strings cast to timestamptz; an enquiry already opens its mail thread (the smoke check
  inserted a second); the C0 smoke and a catalog test used `tasks` as their "not built" example → `visual_search`; the
  "alerts never claim a task" check ran after the tasks were done, so breaking the kind filter stayed green → moved to
  while they are due, then seen red.
- Break-tests, all red then restored: an offer allowed in a draft, an action that reaches an agency, the claim without
  its kind filter, the daily limit raised.
- Live model (the user's go): the four C8 checks green from the first run. In the longer v17 prompt the guide twice
  answered "what else might I like?" without calling discover_homes (2 of 4 runs) → the rule moved into the tool's own
  description; green since. The check faults it found: "your judgment" (US spelling) read as a judgement; a fake
  user id "smoke" on a metering row. One run lost to DNS (ENOTFOUND). Then 15/15 three runs in a row; offline 22/22.

## 2026-11-04 (later) — Claude Code (Mac) — C7 Discovery & Opportunity in the user's autonomous loop

- C6 committed (`06be73a`, `2f6e617`) and pushed after 0086, the bucket and the live run (the user's go). C7 mock
  approved (all ten decisions) and committed (`e246290`). Migration 0087 (`discovery_hidden`) applied (the user's go).
- Built: Discovery AI (Similar homes from a listing's own details, cached for everyone; For you from the profile
  while it is on; homes not for sale only where this site sold 12+ months ago and nothing is listed or being prepared;
  "Not for me" by address, cleared by Forget everything in the same transaction) and Opportunity AI (price reduced =
  the newest change lowered the low end; 60+ days in this campaign; below this site's median for the same suburb,
  kind AND bedrooms with 10+ sales; fixed text and questions; empty signals say why). Guide: two tools, prompt v16.
- Fixed in the loop: a smoke check expected no signal on a "Contact agent → $600,000" home, which correctly asks
  below the median (the check now rules out only a reduction); the "Before" column of CONSUMER-SKILLS had been
  overwritten for rows 7–11 — restored, with a new "Now" column.
- Break-tests, all red then restored: over budget allowed, a judgement word in our text, a judgement line in the
  prompt, For you read once per suburb (9 queries, not 8), the median without the bedroom match, the 12-month rule
  removed.
- Live model (the user's go): first run, the guide answered "what else might I like?" without calling discover_homes
  ("I don't have a profile for you") → prompt v16 now says only the tool knows. Then three faults in the CHECKS, not
  the guide: "not currently for sale" not matched; a refusal ("neither is a good deal", "yours to answer", quoted
  words) read as a judgement — now one helper, checked offline to still catch four real judgements; a figure regex
  that swallowed a sentence comma. Live group 11/11, twice; offline group 19/19.
- Rendered on the built app: /opportunities (Pakenham: 3 long campaigns, both empty reasons), a listing's Similar
  homes, /account/for-you → sign-in.

## 2026-11-04 — Claude Code (Mac) — C6 Inspections built in the user's autonomous loop

- The user approved all nine C6 decisions and asked for the loop (implement → test → fix, report at the end).
- Built: `packages/core/src/inspections/` — the day planner (agents' OPEN times only; one time per home; every
  combination of a home's times that day, fewest unreachable then fewest tight then earliest finish; tight = less
  than the buyer's time inside left on arrival; never drops a home), PostGIS straight-line distances in one pairwise
  query, the plan link (homes + times, so a removed time still names its home), .ics and the Google Maps link; the
  fixed house/apartment checklist; owner-only notebooks (`inspection_note:read/manage`, PUBLIC_SITE_USER tables);
  photo bytes identified by signature and stripped of Exif/XMP/IPTC/comments; the private-bucket client; the
  summary's checks (references, figures, verdict rule, condition words only when the buyer wrote them). AI: the
  summary writer (inspection-summary@v1), `plan_inspections` (records only), prompt v15. Web: `/inspections`,
  `/inspections/calendar`, "Add to my day" + tray on listings, "Plan inspections" on the shortlist,
  `/account/inspections` (+ one notebook per home with photos), three API routes. Migration 0086 written.
- Fixed in the loop: the plan link could not name a home whose time the agent deleted (the row is gone) → the link
  carries the homes too; a UTC date in the guide's "next open" line → the plan's zone; a 4.5 MB serverless body
  limit → the browser resizes to 2,048 px and the server caps at 4 MB (the mock's 10 MB is the camera file); the
  empty plan said "that day" with no day.
- Break-tests, all red then restored: the tight threshold, keeping Exif (APP1), the condition rule, an N+1 in the
  planner (11 queries, not 3).
- Refused by the permission check at first: applying 0086. Then the user's go: 0086 applied (2 tables, RLS on, 6
  indexes checked), the private `inspection-photos` bucket made through the Storage API (public off, 4 MB,
  JPEG/PNG; 0 storage policies). The notes smoke check then failed on its own bug (it reserved a cross-user key on a
  home already full) — fixed in the check, not the code. Smoke "Consumer skills" 16/16; live group 25/25 (the user's
  go) — the summary writer kept 6/6, the guide planned a Saturday from plan_inspections with no driving time.
  Committed and pushed.

## 2026-11-03 (later) — Claude Code (Mac) — C4 completed; C5 Research in the user's autonomous loop
- C4: shortlist `a599f7d`, Property Monitor `e42736a` (0083), Personal Property AI `b3f5082` (0084), Smart Alerts
  upgrade `bdf87a5` — each smoke-green and broken on purpose once; the alerts check found a silent sold_date bug.
- C5 (the user: run implement → test → fix without stopping; decisions as recommended): ABS 2021 GCP DataPack (SAL)
  → housing-only CSV (15,345 suburbs) by `packages/db/data/census/build-sal-2021.py`; migration 0085 `suburb_census`
  applied; `db:census` loaded twice (idempotent). Core research (gated medians by Postgres, home rows, comparables,
  verdict rule), research writer, `/api/research`, suburb / compare pages, Explain this home, Compare from the
  shortlist, three guide tools + prompt v14. Unit core 1698, ai 380; smoke 13/13. Break-tests: median gate 10→9 and
  the verdict filter removed — both red. Live model NOT run (no consent to spend). Fixed in the loop: a page-file
  export that `next build` refuses (moved to lib/suburb-slug.ts); an unknown state or a name we know nothing about
  answered 200 after streaming began — now a 404 from `[suburb]/layout.tsx`, outside the loading boundary; stale
  generated route types in `.next-dev/types` (dropped; regenerated by the build). Web build green.
- Live model (the user's go): two C5 checks added to "Consumer skills, live AI" — the research writer on Pakenham's
  records (core keeps most lines, none a verdict) and the guide on "is Pakenham good value?" (calls suburb_profile,
  no verdict, no figure the records lack, no description in its own words). The first runs found: the guide
  called Pakenham "well-established" with "decent" growth the records cannot show → v14 bullet against describing
  a place in its own words; after that the guide (3 runs in 5) answered "how much to knock out a wall in Victoria" with the
  no-price sentence and a request for a listing, without calling renovation_plan → v14 now adds to v13's
  Renovations line "call it before you answer… the state alone is enough" (v13 unchanged), and the research tools
  get "a suburb or a state is enough". The verdict check was too blunt (it flagged the guide echoing "Is it good value?" and
  "whether that is good value depends on you") → now per sentence, setting aside questions and sentences that
  hand the judgement back; checked offline that a real verdict still goes red. Live group 20/20, twice.
- C5 committed in two: the census (migration 0085, data, loader) and the research features; pushed.
- Next: C6 Inspections mock (`docs/mocks/consumer-inspections.html`) for the user's review.

## 2026-11-03 — Claude Code (Mac) — ADR 0080: consumer skills; C0 foundation; C1 stamp duty + mock
- Goal (the user, in Urdu): how much of the client's 21 consumer AI skills exists (~16%); plan them all properly, with a
  Skills section where the buyer turns each on or off; then start building.
- Decisions (the user, all recommended): answers ON / acts OFF; our records + free public data first; after the
  foundation, Affordability → Due-Diligence → Renovation. Then: apply 0080 + 0081, smoke, commit, start C1.
- Done on `feat/consumer-skills` (from `feat/customer-profile`): ADR 0080, `docs/CONSUMER-SKILLS.md`, migration 0081,
  `packages/core/src/consumer-skills`, `consumer_skill:read/manage`, chat gate (`skillBlocks` required on ToolContext),
  Buyer AI off → 403 `skill_off` before the model, Smart Alerts off → no new alert, cron claims none, /alerts notice;
  `/account/skills`. Committed `573f0e7`. Applied 0080 + 0081 (82 recorded). Smoke 5/5 green. Break-tests: chat gate
  and cron gate each red, then green.
- C1 (uncommitted): stamp duty per state with sources checked 2026-11-03 — found TAS's first-home exemption ended
  30 June 2026, WA's first-home rate changed 7 May 2026, ACT's scheme lost its caps 1 July 2026. NT, ACT general and
  SA new-home relief could not be fetched from the official sites (403/404) → "not verified", no figure. NSW/VIC
  phase-out bands are straight-line estimates tagged approximate. 28 tests; one base changed by $18 → 3 red.
- Then (the user: "next start", taken as the mock's six decisions all recommended): repayments, +1%/+2%, borrowing
  at rate + 3% (APRA kept it 28 May 2026), dearest home after duty and costs, the URL reader; `/affordability` (GET,
  added to the middleware matcher for the Skills switch); "Costs to buy" on listings (duty only; `skills_off` cookie
  mirror hides it — display only); `affordability_estimate` + prompt v11 (v10's text + a section; tool list order
  test updated: one cache reset). Unit core 1628, ai 347. Break-test: the tool's skill mapping removed → red. Dev
  server: the mock's figures on the page; a VIC $800k listing → $43,070 for all three buyers (checked by hand).
- Then: C1 committed `dcdce7c`; the 1 July re-check + unverified states as ROADMAP debt and a smoke note
  (`dutyRatesDue`). C2 mock (seven decisions), taken as recommended. C2 part 1: checklists verified from CAV
  (VIC), Fair Trading (NSW), qld.gov.au Form 2 (QLD), Consumer Protection (WA); SA/TAS/ACT/NT general list.
  Migration 0082 `listing_price_change` + trigger, applied (the user's go; 83 recorded). Records from SQL (days on
  the market counted by Postgres). "Before you buy" on listings and /property. Withdrawn campaigns stay out
  (ADR 0013). Smoke green (trigger: draft and headline edits ignored). Unit core 1637, ai 347. Break-test: price
  changes dropped from the facts → red. Dev server: VIC listing and a /property page render the section.
- Then C2 part 2: core `assist.ts` (`publicSubject` — the server decides the address; `checkDraft` — references
  must exist, figures must be in the cited records, no links; summary points must cite a fact), the writer in
  packages/ai (summary tier, metered `consumer:due_diligence`, fake-client tests), `/api/due-diligence` (rate limit,
  daily cap, the Skills switch, an hour's cache under the listings tag; in the middleware matcher), the button and
  "Put into the enquiry form", the guide's `due_diligence` + prompt v12. Unit core 1643, ai 356. Smoke 5/5.
  Break-tests: the public filter removed → "a draft listing was answered"; the tool's skill mapping removed → red.
  Dev server with CONSUMER_AI=off: 400 / 503 paths and the button; the model itself NOT called (no consent to spend).
- Then (the user's go to spend): a new smoke group "Consumer skills, live AI (ADR 0080)" — in-process, because the
  HTTP target is the deployed site. First run: 1 of 6 questions survived — the model wrote "[K2]" into its text and
  `unsupportedFigures` read "2" as a figure. Fixed: `cleanLine` in core + prompt due-diligence@v2; the test's own
  figure regex (a trailing comma) and allowed list (now from the tool's result) fixed too. Second run: 8/8 green
  (summary 2/2, questions 6/6; the guide copied $10,925 and cited R1/R2). Committed C2.
- Then C3 Renovation AI (approved by the product team): core categories/plan/quotes (`5bd7be8`); permit rules VIC,
  NSW, QLD through domain-restricted official search — Victoria's regulator is now the Building and Plumbing
  Commission (bpc.vic.gov.au) (`e8b683e`); end to end: planner + room reader in packages/ai, `/api/renovation`,
  `/api/renovation/rooms`, `/renovation` with quotes compared in core, the listing link, `renovation_plan` with the
  25 kinds as its enum (prompt v13). Unit core 1665, ai 368; smoke 7/7 (incl. the endpoints' permission check and
  a "condition" photo answer refused). Break-tests: a source on the wrong state's domain; the tool's switch. Dev
  server (CONSUMER_AI=off): the page, the link, 400/404/503.
- Live model (the user's go): "Consumer skills, live AI (ADR 0080)" 12/12 — the planner kept kitchen, remove_wall,
  deck for a request that asked the cost, no money in any line; the guide gave no price and said why. Committed C3.
- Left unfinished (exact next step): WA, SA, TAS, ACT, NT permit rules; TEST-PLAN CG/CH/CI in a browser; C4 mock.
- Risks / watch: rates go stale every 1 July; the borrowing estimate is not a bank's (decision 2).

## 2026-11-02 (later) — Claude Code (Mac) — ADR 0079: the customer profile
- Goal (the user, in Urdu): agencies add their old customers; every profile starts with name, email, phone and
  address and collects the rest over time; the same person again lands on the same profile.
- Decisions (the user, four answers, all the recommended option): same email = same person automatically, same phone
  = a suggestion (as ADR 0018); fill blanks, never overwrite, the other value on the timeline; an import row without
  phone/address still imports and shows "missing"; a full address with the map picker.
- Done on `feat/customer-profile` (from `feat/sms-part2`): migration 0080 (`contact.address_*`); `addCustomerSchema`,
  `planFill`, `addOrFillContact`, `addCustomer`; import address columns + fill instead of skip; form picker; profile,
  list, search; merge carries the address; ADR 0079; TEST-PLAN CF; smoke group "Customer profile (ADR 0079)" + the
  import check rewritten. Unit core 1579 (+23), ai 335; typecheck 10/10; console build OK; lint 0. Break-tests: an
  overwriting `planFill` and a missing `contact:create` check each went red, then green. The single-table-subquery
  guard caught an interpolated `contact.id` in the fill's roles subquery — written out.
- 0080: rolled-back dry run clean (twice; 10 contacts; then a read-only check: 0 address columns, 80 recorded). NOT applied.
- Left unfinished (exact next step): the user's go to apply 0080 → the two smoke groups → TEST-PLAN CF → push/merge
  the three branches in order.
- Risks / watch: `feat/customer-profile` reads the new columns — never deploy it before 0080.

## 2026-11-02 — Claude Code (Mac) — this laptop caught up; Retell agent; ADR 0074 part 2 (SMS everywhere)
- Goal: catch the Mac up after a week on the other laptop; Retell keys; then 3.4 part 2 on the user's answers.
- Done: `retell:setup` against the Vercel web domain (`RETELL_AGENT_ID=agent_93b24a5de57c293fe91e59d943`, set in the
  Mac `.env.local`; Vercel envs left to the user — the agent may not write Vercel secrets). Checked first that Vercel's
  INTEGRATION_TOKEN_KEY is the Mac's (the deployed webhook answered 400 to a token made with the local key, not 403).
  ADR 0074 part 2 on `feat/sms-part2` (from `chore/tech-debt`): migration 0079, `phone/sms-rules.ts`,
  `template-email/sms-batches.ts`, step `send_template_sms`, skills `bulk_sms` + `workflow_texts`, minute job
  `smsBatches`, missed-call text now 3 automatic a caller + 100 a number, console Bulk SMS / Text selected / Texts to
  customers. Unit: core 1556, ai 335; console build OK; lint 0 errors. Break-tests: rule-2 order and the
  never-as-email guard each red, then green. The tool-CHECK test caught a stray ")" in 0079 — fixed.
- Decisions (the user): numbers come with Twilio tonight; consent — the user asked for "everyone once the skill is on",
  kept at the Bulk email rule (Spam Act), told the user why; 9–8 OK; 3 automatic texts a caller (not 1); 100 a number OK.
  New guard: `SMS_DEV_ALLOWLIST` (dev DB = production DB, a real key would text real people).
- Then: 0079 dry run (rolled back, twice, clean); the agent was refused applying it (auto mode: production), the user
  applied it from this Mac (two earlier tries reached another database — checked read-only each time); smoke "SMS
  everywhere (ADR 0074)" 1/1 green; committed on `feat/sms-part2`.
- Left unfinished (exact next step): push `feat/sms-part2` and merge (the user's go); Vercel envs (the user, doing it);
  the Voyage backfill (on hold — the user); Twilio tonight → TEST-PLAN BX/BY/BZ/CE.
- Risks / watch: 0079 must be applied before this code reaches production; "Text selected" only ticks buyers the email
  rule allows (ADR 0060 decision 4) — a buyer with a mobile but no email cannot be texted from that tab yet.

## 2026-10-31 — Claude Code (Mac) — SMS part 1, ADR 0075, Outlook, AI understands, Phase 7 mocks, tech debt
- Goal: the user's v1 list while the client reviews; then the Phase 7 mocks; then clean the house.
- Done: ADR 0074 (SMS templates by channel, `call.missed`), ADR 0075 + 0076 (one address, several agencies; zero-
  downtime two-step), ADR 0076 Outlook (migration 0077), ADR 0078 AI understands (migration 0078, plus the missing
  `switch_skill` in the tool CHECK) — all merged to `main`, smoke groups green. Mocks for the client: SMS rules,
  Control Centre, 4.4 triggers. Phase 7 mocks for the user (approved): voice control, Property Management,
  recruitment + training, team workload board. Tech debt on `chore/tech-debt`: CI, STATUS/SESSION archived, smoke reds fixed (cron reads vercel.json; the inbox
  check counts contact threads; two team loaders), each broken on purpose and seen red.
- Files touched: `.github/workflows/ci.yml`, `packages/smoke/src/index.ts`, two `team/**/loading.tsx`, `docs/STATUS.md`, `docs/SESSION.md`, `docs/archive/`, `docs/HANDOFF.md`,
  `docs/ROADMAP.md`, `docs/mocks/` (four Phase 7 mocks + README).
- Decisions: Phase 6, Xero, CRM connectors AND Phase 7 are version 2 (the user). CI gets no secrets.
- Left unfinished (exact next step): merge `chore/tech-debt` (the user's go), a full smoke run, the two local-only
  branches (keep or delete — the user).
- Risks / watch: dev DB = production DB; never run the minute cron locally; test agency only; alias emails only.
