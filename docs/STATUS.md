# Status
- **2026-10-31 — smoke "Tenant isolation" 5/5 green** (SMOKE_ENABLED=true SMOKE_ONLY="Tenant isolation"): the new ADR
  0075 check (two agencies, one address) passes; "tokens and the sync job" fixed — its fixture gave agents the
  agency's Zoom, which the rule since 2026-10-22 (`f7cbc4d`) refuses; agents now connect their own and the check
  asserts their Zoom meeting uses exactly that token. TEST-PLAN CA (ADR 0074) and CB (ADR 0075) added; HANDOFF
  rewritten for either laptop. **Next:** Phase 4.4 triggers mock.
- **2026-10-31 — ADR 0075 (ROADMAP technical debt): one address, several agencies. Built on `feat/property-per-agency`,
  merged to `main` (`206f30c`, deployed and verified by the user); migrations 0075 AND 0076 APPLIED (77 recorded;
  41 listings backfilled; only `deal_open_agency_property_idx` remains). Rollout complete.** Option A (the user): `listing` holds its ad's seven facts; `upsertProperty`
  never overwrites an existing address (facts only filled, pin moved only when nobody else uses the address);
  every read through `listings/facts.ts` (listing first); deal sync per agency. Checks: core 1498 + ai 331;
  typecheck all; break-tests red/green (source-scan guard, deal conflict); rolled-back real-DB run of 0075+0076
  with two agencies on one address — 8/8 PASS. Smoke check in "Tenant isolation" written, not run.
  **Next:** run the smoke check in "Tenant isolation" when the user agrees; the client's approvals (SMS rules,
  Control Centre decisions); then ROADMAP 3.4 part 2 / 4.4.
- **2026-10-31 — ROADMAP 3.4 part 1 (ADR 0074), migration 0074 APPLIED (75 recorded), merged to `main`.**
  `email_template.channel` (email/sms, CHECK); `mayUseTemplate` / `usableTemplateSql` / `listTemplates` default to
  email, so no email path sends an SMS template; `template-email/sms.ts` (480 chars, STOP footer, SMS parts);
  SMS templates through `createTemplate({ channel: 'sms' })`. Trigger `call.missed` (caller known/new/either,
  `{{caller_phone}}`, a personal workflow on its owner's own calls, a new number only reminds), emitted by
  `recordMissedCall` in the call's transaction (origin `system`); the assistant's create_workflow takes `caller`.
  Checks: core 1491 + ai 331 pass; typecheck core/ai/db/smoke/console/web; break-tests red then green (channel
  guard, scope, new-caller guard); 0074 dry-run twice in a rolled-back tx (sms in, fax refused, call.missed in,
  a bogus kind refused). NOT checked: a real missed call emitting the event; no SMS template UI yet. Mocks for
  the client: `sms-everywhere.html` (5 rules), `control-centre.html` (4 decisions, ROADMAP 4.6/4.7). Seed +
  scoped deal sync for the phone test agency. **Next:** ADR 0075 — the shared property row and one open deal
  per property across agencies (ROADMAP technical debt), before go-live.
- **2026-10-31 — database state corrected: all 74 migrations (0000–0073) are applied and recorded. Nothing is
  pending; run no migration.** Checked read-only on the shared database (both laptops use the same `DATABASE_URL`):
  `workflow_event_kind_check` has `appointment.completed` and `workflow_run.decision` exists (0069); 0070 is
  recorded (no active template-email workflow, so it kept nothing on); the phone tables/columns of 0071–0073 exist,
  RLS on `missed_call_setting`. The 2026-10-30 warning below (0069 not applied, 0070 on hold) was wrong, and
  HANDOFF.md §1/§4 and ROADMAP 3.1–3.3, 4.1–4.2 are corrected. **Live by the client's decision (ADR 0069): every
  skill is OFF until switched on**; only "Missed call text" and "AI call back" have ON rows (the test agency).
  Agency owners must switch on the skills they want. **Next:** the user walks TEST-PLAN BN–BZ; ROADMAP 3.4 mock.
- **2026-10-30 — handoff to another laptop: read `docs/HANDOFF.md` first.** Everything through `fcbf35e` is merged
  into `main` and pushed (by the user). Built since 2026-10-28: Skills default OFF + Workflow emails + pair skills
  (ADR 0069), Phone & SMS 3.1–3.3 (ADR 0070–0072), minute-tick batching (ADR 0073, no migration),
  `docs/DNS-CUTOVER.md` + `phone:repoint`. (This entry's migration warning was wrong — see 2026-10-31 above: all of
  0069–0073 are applied and recorded.) Checks: core 1466 pass (3 = pre-existing Windows/imports), the
  Phone & SMS smoke group 3/3 on the real DB (rolled back), browser walk of 3.1–3.3 on the test agency with stub
  Twilio + Retell. Real keys not tested (the user's choice). **Next:** the 0069/0070 decision, then ROADMAP 3.4.
- **Automation Library (ADR 0068, 2026-10-28), ROADMAP 4.3, on `feat/sidebar-groups` (not committed). No migration.**
  Core `workflows/library.ts` (10 entries: words for the card and the assistant's box, never a spec; likeThisOn);
  WorkflowSummary gains triggerKind/decides. Console: the library at the top of the agency's Automations tab (owners
  and admins), group chips in the URL, "Use this" → `/overview?ask=…` (typed, not sent). Checks: core 1412 pass
  (3 = pre-existing Windows; count break-test red then green), ai 329 (2 = pre-existing); typecheck; lint 0; build
  compiles. **Next:** BV (and 0069 for the entries on the new triggers).
- **AI decides (ADR 0067, 2026-10-28), ROADMAP 4.2, on `feat/sidebar-groups` (not committed). `workflow_run.decision` added to migration 0069 (regenerated; still NOT applied).**
  Core: catalog `decide` (2–4 labelled choices; the workflow's own steps are "Not sure"; DECIDABLE_TRIGGERS;
  stepsProblem per choice; allActions), `workflows/decide.ts` (what the AI reads, budget, pickChoice, decideRun —
  never fails a run), engine runs the chosen steps and stores the decision; skill "AI decisions in workflows".
  ai `pipelines/workflow-decide.ts` + prompt workflow-decide@v1; assistant create_workflow.decide, prompt v30; the
  minute cron passes the decider. Console: the decision and its choices on the Automations tab, "AI chose …" on runs.
  Checks: core 1409 pass (3 = pre-existing Windows; label-check break-test red then green), ai 329 (2 = pre-existing);
  typecheck core/ai/console/web/smoke; lint 0; build compiles. **Next:** the go for 0069, then BT and BU.
- **More workflow triggers (ADR 0066, 2026-10-28), ROADMAP 4.1, on `feat/sidebar-groups` (not committed). Migration 0069 (widens `workflow_event_kind_check`) written, NOT applied — needs the user's go.**
  Core `workflows/`: catalog (7 triggers + TRIGGER_GUIDE), scans.ts (deal events per side, buyer matches via
  briefFitsSql, upcoming appointments, appraisals not listed, sale anniversaries — keyed, deduped, never before the
  oldest such workflow), engine (triggerMatches, inScope per kind, the tick runs the scans), completeAppointment emits
  appointment.completed. Assistant: create_workflow's new fields; prompt v29. Console: the Automations tab's
  "What can start a workflow". Checks: core 1400 pass (3 = pre-existing Windows; deal-side break-test red then green),
  ai 326 (2 = pre-existing); typecheck all; lint 0; build compiles. **Next:** the go for 0069 (rolled-back run with
  the scans on the real data first), then BT.
- **Migrations 0067 + 0068 APPLIED 2026-10-28 at the user's go (69 recorded), after a rolled-back run on the real DB, 19/19: both migrations, RLS on the three tables, the deal sync on the real listings (27 opened — 23 Marketing, 4 Contract — and 16 standard conditions; a second run changes nothing; one open deal per property), the board, the Deal tab, a $782,000 commission at 2.2% to the cent, Finance tiles adding up, the Properties list under every filter and search, the property page, an agent's narrower list with no offer or commission on 15 pages and "not found" off his addresses, no offer count on his cards, the summary checks with a fake model. Then, applied, a rolled-back settle 5/5: Settlement, buyer and vendor tagged Past client (inferred), Mark agent paid in Finance. The run found two untyped parameters in the sync (conditions' sort, the reminder offset) — fixed, with a guard test (break-tested).** The deal sync was then run once for real at the user's go (2026-10-28): 27 deals opened (23 Marketing, 4 Contract), 16 conditions, 27 events, no reminders due; a second run changed nothing.
- **Property page (ADR 0065, 2026-10-27), ROADMAP 2.3, on `feat/sidebar-groups` (not committed). No migration; reads 0068's `deal` (applied 2026-10-28).**
  Core `properties/`: visibility.ts (visiblePropertyIdsSql — owners/admins any address the agency has a record of, others
  only their own; lead/appointment rules in SQL from can()), property-page.ts (getPropertyView: facts, campaigns, deal,
  leads, appointments, open homes, people, documents, timeline; listProperties), summary.ts (numbered records, checks,
  budget, the new Property summaries skill). ai `pipelines/property-summary.ts` + prompt property-summary@v1. Console:
  /properties, /properties/[id], /my-properties(…); links from the listing page, a contact's Properties tab and a
  listing-less Pipeline card. Fixed on the way: the Pipeline card showed agents an offer count (now owners/admins only).
  Checks: core 1387 pass (3 = pre-existing Windows; offer-guard break-test red then green), ai 326 (2 = pre-existing);
  typecheck core/ai/console/web/smoke; lint 0; build compiles. Not on a real DB yet. **Next:** fold into the 0068 rolled-back run; BS.
- **Commissions + Finance (ADR 0064, 2026-10-27), ROADMAP 2.2, on `feat/sidebar-groups` (not committed). Commission columns added to `deal` in migration 0068 (applied 2026-10-28).**
  Core `deals/commission.ts`: COMMISSION_JOINS/COLUMNS (one SQL expression: percent or fixed, split = deal else agent_profile,
  agency share = commission − agent share, GST 10%), setDealCommission/markCommissionPaid (`deal:commission`, owners/admins),
  financeReport (FY July–June on the agency clock; agency scope via report:read_agency, else own) + groupFinance (cent sums).
  Console: Deal tab CommissionPanel; /finance (placeholder replaced) and /my-commission; sidebar Money. Checks: core 1376
  pass (3 = pre-existing Windows; cent-rounding break-test red then green), ai 323 (2 = pre-existing); typecheck all; lint 0;
  build compiles. Not on a real DB yet. **Next:** the go for 0067 + 0068 (rolled-back run first), then BN–BR.
- **Deal pipeline (ADR 0063, 2026-10-27), ROADMAP 2.1, on `feat/sidebar-groups` (not committed). Migration 0068 (deal, deal_condition, deal_event, deal_stage enum) APPLIED 2026-10-28 after a rolled-back run (see the top entry); the sync ran on the real listings there.**
  Core `deals/` (stages.ts pure; sync.ts: link appraisal→listing, open from sale listings/appraisals [60-day backfill],
  forward-only moves from listing status + offers, withdrawn, standard conditions at Contract, reminders 2 days before
  each condition/settlement; deals.ts: board, Deal tab, details/stage/settle/conditions with listing:edit). Minute cron runs
  runDealSync. Console: Properties → Pipeline (/pipeline, /my-pipeline), listing page Deal tab (DealEditor island). Assistant
  find_deals, prompt v28. Checks: core 1368 pass (3 = pre-existing Windows), ai 323 (2 = pre-existing time-zone); typecheck
  core/ai/console/web/smoke; console lint 0; console build compiles. **Next:** the go for 0068 (rolled-back run first), BQ.
- **More contact roles (ADR 0061, 2026-10-27), ROADMAP 1.5, on `feat/sidebar-groups` (not committed). Migration 0067 (`contact_role_kind` + prospect, past_client, referral_partner) APPLIED 2026-10-28 at the user's go.**
  CONTACT_ROLES + labels; import synonyms (past/former/previous client, referral/referrer/referral partner/source,
  potential client); not a consent role. Checks: core 1352 pass (3 = pre-existing Windows), typecheck core/ai/console.
- **Inbox assistant (ADR 0062, 2026-10-27), ROADMAP 1.6, on `feat/sidebar-groups` (not committed). No migration.**
  Core `mail/reply-assist.ts` (numbering, switch + budget gate, checkSummary, bracketUnsupported), ai
  `pipelines/reply-assist.ts` + prompt reply-assist@v1, console Composer + ReplyAssistant island, actions in
  `lib/reply-assist-actions.ts`. Summary only on a button (the user). Checks: core 7 + ai 4 new tests, guard
  break-test red then green; typecheck core/ai/console; console lint 0; read-only real-DB run with FAKE model
  functions (4 messages numbered, a bad citation dropped, an unsourced price bracketed). No live model call yet.
- **Matched buyers on the listing (ADR 0060, 2026-10-27), ROADMAP 1.4, on `feat/sidebar-groups` (not committed). Migration 0066 (`email_batch.listing_id`, `listing_snapshot`) APPLIED 2026-10-27 at the user's go (67 recorded), after a rolled-back run on the real DB, 13/13: the tab lists a sample brief, count = tab, a listing template refused without a listing, the batch keeps frozen values, preview has no braces, a later listing change does not reach it, ONE remind step at 9 am tomorrow with title/body/href, a second press makes nothing.**
  Checks: core 1351 pass (3 = pre-existing Windows path failures), ai 319 (2 = pre-existing time-zone); typecheck
  core/ai/console/web/smoke; console lint 0; console build compiles. Waiting for the user's browser walk of TEST-PLAN BN.
  Core `buyer-matching/` (match.ts: ONE rule `briefFitsSql` over given values or a listing's columns, shared by find_buyers,
  the tab and the counts; buyers.ts: listingBuyers with bulk-email's `classify` per buyer, matchingBuyerCounts in one
  statement, scheduleBuyerCallTask = one assistant task with one `remind` step at 9 am tomorrow, body = buyers + phones,
  href = the tab). Template email: `{{listing_address}}`, `{{listing_price}}`, `{{listing_link}}` (listing-values.ts),
  frozen into the batch at Prepare; a template using them is refused without a listing; the link refused for a listing
  not live. `notifyMyself` takes body/href. Console: listing edit page → tabs (Details · Photos · Documents · Matching
  buyers), shared `components/listings/listing-page.tsx`; BuyerPicker island (boxes off for anyone bulk email would skip,
  Email selected → template → Prepare & review → batch page; Remind me to call); Listings table Buyers column.
  find_buyers now reads the shared module ("leased" now counts as rent). **Next:** the user walks BN; commit 1.4.
- **find_buyers (ADR 0059, 2026-10-27), ROADMAP 1.3, committed on `feat/sidebar-groups` (not pushed). No migration.**
  Read tool over `buyer_requirement`: a listing (P) OR the property in words; the matcher's rule from the property's side
  (`briefFitsSql`, open ends open), contacts the person may read, active briefs; frame `buyers` says what was searched
  (`describeTarget`) and each brief (`describeRequirement`, never the note); listing mode marks who already enquired.
  Prompt v27. Checks: core 1345 pass (3 = pre-existing Windows; 8 new + rule break-test red then green), ai 319 (2 =
  pre-existing time-zone); typecheck core/ai/console/web/smoke; console lint 0. Real DB: the four searches run read-only;
  a sample brief in a ROLLED-BACK tx matched/didn't on price, beds, suburb (any case), type, channel — 10/10, count
  unchanged. The agent-visibility case was not exercised live (shared visibleContactIdsSql). The user checked it in a
  browser with dummy briefs (2026-10-27). **Next:** 1.4 — mock first (matched buyers on the listing + email them).
- **Skills Control Centre (ADR 0058, 2026-10-27), ROADMAP 1.2, committed on `feat/sidebar-groups` with 1.1 (not pushed). Migration 0065 APPLIED 2026-10-27 at the user's go (66 recorded; RLS on, no anon/authenticated grants), after a rolled-back run on the real DB: the migration + every switch function through Drizzle, 14/14 OK.**
  `skill_switch` (no row = on; user_id null = the agency's, owners/admins; else a member's own; independent). Core
  `skill-switches/` (catalog: 16 skills, 3 agency-only; switches: list/isSkillOn/set/skillsOffFor/skillsOffForActor);
  can() `skill_switch:read|manage`. Gates: assistant tools refused at run time (one read per turn via ToolContext.skillsOff,
  tool lists unchanged), opportunity scan (dropSwitchedOff), workflow draft_email step, AI import mapping/cleaning, bulk
  email page actions. Tool `switch_skill` (card → runSwitchSkill → verifySwitchSkill), find_skills lists platform_skills,
  prompt v26. Console: Skills page with tabs (?tab=platform|ai|automations, ?show=on|off), cards + switch island,
  /workflows + /my-workflows redirect to the Automations tab, sidebar Automation = Skills only. Checks: core 1337 pass
  (3 = pre-existing Windows), ai 319 (2 = pre-existing time-zone); gate break-test red (3) then green; typecheck
  core/ai/console/web/smoke; console lint 0; console build compiles. The user checked the sidebar and Skills UI in a browser (2026-10-27).
  **Next:** push + deploy (0065 is live, so this code is safe to deploy); walk TEST-PLAN BL on the deployed app.
- **Sidebar in groups (ADR 0057, 2026-10-27), ROADMAP 1.1, committed on `feat/sidebar-groups` with 1.2. No migration.**
  `surfaces.ts` lists the nav as `groups` (Daily work · People · Properties · Marketing · Automation · Knowledge &
  insights · Money · Settings); `nav-list.tsx` draws collapsible headings: Daily work and the current page's group
  start open, and a closed group with something unread shows a dot. Agency Insights → /insights (was the admin
  /site-activity, which sent agency users home); agent "Offers" (#) removed. Checks: console typecheck + eslint
  clean. The user checked it in a browser (2026-10-27).
- **AI contact import (ADR 0056, 2026-10-26) — committed on `feat/documents` (not pushed). Migration 0064 APPLIED 2026-10-26 at the user's go (65 recorded).**
  Step 1 mapping: after a contacts upload (CSV/xlsx/sheet/re-import), if a headed column is unused and a field
  unmatched, headings + 5 MASKED sample rows (x/X/9) → model; synonyms stand, the model fills empty fields only;
  `listing_import.ai_mapped` marks them "✦ AI" (unmarked when changed). Step 2 cleaning: opt-in checkbox
  (`ai_clean`, off by default); only failing rows' mapped cleanable fields; guards (`acceptFix`) prove each value
  came from the row, then `normalizeContactRow` decides; changes are row warnings "Fixed by AI … check it".
  Core `imports/contact-ai.ts` (pure) + contacts.ts/imports.ts; ai `pipelines/import-assist.ts`
  (beta.messages.parse + betaZodOutputFormat, Opus 5.5 low effort, fallbacks, 30 s, metered `import-map` /
  `import-clean`); per-agency cap IMPORT_AI_DAILY_BUDGET_USD_PER_AGENCY (default 1). Wired in console actions and
  the web alerts cron. Checks: core 1322 pass (3 = pre-existing Windows), ai 319 (2 = pre-existing time-zone);
  break-test red (guards off → 6 fail); typecheck core/ai/console/web; console lint 0; build compiles; new actions
  pass the session check (replayed, CRLF normalised). Real DB, ONE rolled-back tx with FAKE mapper/cleaner (no
  model): 0064 applied; synonyms matched nothing, the merge filled 6 fields; a dirty row fixed on all 5 fields;
  an invented domain refused. NO live-model call made yet. TEST-PLAN BJ; DEPLOY "AI help for the contacts import".
  **Next:** push; deploy (0064 is live, so the code is safe to deploy); walk BJ live after deployment (the user's
  choice: no live-model run before it). Address on contacts is a separate later feature (geocoding + contact_property).
- **Smart buyer matching (ADR 0055 §6, 2026-10-26) — committed on `feat/documents` (not pushed). No migration.**
  New opportunity kind `buyer_match` (`opportunities/detectors.ts`): the agency's own listings live within 7 days,
  same channel, price ranges overlap (no stated price → no match when the brief has a budget), beds/baths at least,
  suburb/type in the brief, not already enquired; recipient = the contact's assignee. Key brief+listing (told once).
  Ranked 2nd in KIND_ORDER. Template in describe.ts (brief summary kept in facts); panel: Open → Requirements tab,
  "The listing ↗" → public ad. Checks: core 1310 pass (3 = the pre-existing Windows tests); typecheck core/ai/console
  clean; console lint 0; build compiles. Real DB: read-only run OK (~0.7 s warm, like the other detectors); in ONE
  rolled-back tx a fitting brief matched a real live listing, under-budget / other suburb / more beds / other
  channel / paused / already-enquired did not, the full scan created it and a second scan created 0. TEST-PLAN BI13–19.
  **Next:** walk BI13–19; Feature 3 (AI contact import) in progress.
- **Buyer requirements (ADR 0055, 2026-10-26) — committed on `feat/documents` (not pushed). Migration 0063 APPLIED 2026-10-26 at the user's go (64 recorded with 0062; RLS on, no anon/authenticated grants).**
  `buyer_requirement` (typed: channel, price_min/max, min_bedrooms/bathrooms, suburbs[], property_types[], note,
  status active/paused; ≤ 10 per contact). Core `contacts/buyer-requirements.ts` (list/create/update/setStatus/delete),
  zod `buyerRequirementSchema` + `describeRequirement` in contact-schema.ts; read = `contact:read`, write =
  `contact:update` (no new action). Merge moves them; counts gain `requirements`. UI: contact **Requirements** tab
  (`requirement-form.tsx`), "Looking for" on Overview. **Also fixed:** `approveListings` now emits
  `listing.status_changed` (one insert, same transaction) — approved listings never reached workflows before.
  Checks: core 1306 pass (3 = the pre-existing Windows path/CRLF tests; the new server actions pass the session
  check replayed with CRLF normalised); break-tests red (approval event; contact:update guard); typecheck core/ai/
  console/web clean; console lint 0; console build compiles. 0062 + 0063 + every new write (create/list/edit/pause/counts/delete, approveListings → its event) run first in ONE rolled-back transaction on the real DB (OK). TEST-PLAN **BI**.
  Both tables are live, so deploying this code is safe now.
  **Next:** walk BH + BI (BI13–19 = matching).
- **Proactive opportunities (ADR 0054, 2026-10-26) — committed on `feat/documents` with ADR 0055 (not pushed). Migration 0062 APPLIED 2026-10-26.**
  `opportunity` (one row per agency + dedupe_key; status open/done/dismissed/expired). Five SQL detectors
  (`opportunities/detectors.ts`): sale anniversary (5/10 years, owner or vendor), cold contact (90 days), unanswered
  email (48 h–21 days, never offers), appraisal follow-up (3–30 days), repeat interest (3 in 30 days). Recipient = the
  assignee (or a sold listing's lead agent), active member, agency not suspended. Hourly cron /api/cron/opportunities
  (:17): expire after 30 days, ≤ 10 new per person, one bell notification per person per scan. Panel "Opportunities"
  on /overview and /assistant (Open, Ask the assistant = question typed into the box via `?ask=`, never sent; Done,
  Dismiss). No model anywhere — every sentence is a template over SQL facts. `opportunity:read/update` = the recipient only.
  **Fixed on the way (documents tick, committed code):** Drizzle spreads a JS array into a record, so the chunk
  embedding update (`unnest(${ids}::uuid[])`) would have failed at the first embed — now a jsonb_to_recordset param.
  Checks: the detectors run read-only on the real DB (~0.5 s each, 2 real unanswered emails found); migration 0062 + two
  full scans + the panel query + the fixed embedding update run in ONE rolled-back transaction (created 2, notified 2,
  then created 0; table absent afterwards). Core 1284 pass (3 = the pre-existing Windows tests), ai 312 (2 pre-existing),
  typecheck/lint clean, web + console builds OK. TEST-PLAN **BH**. Smoke check not written.
  **Next:** walk BG + BH.
- **Documents + knowledge base + inbound attachments (ADR 0053, 2026-10-26) — committed on `feat/documents` (not pushed). Migration 0061 APPLIED 2026-10-26 at the user's go (62 recorded; RLS on both tables, no anon/authenticated grants); the tick's raw SQL run in a rolled-back transaction and the list/search/read queries run as dummy actors on the real DB (OK). The user made the `documents` bucket; Resend + Vercel env tonight.**
  `document` (a record on a contact / a listing's property, or the agency `knowledge` base) + `document_chunk` (page-aware
  chunks, generated tsvector, nullable voyage vector) + `mail_message.attachments_stored_at`. Private bucket `documents`:
  signed upload → HEAD → row; a 60 s signed download through /api/documents/[id]. One visibility rule, `documentScopeFilters`
  (knowledge → every member; a record → admins, its uploader, and unless private whoever reads the contact or is named on
  the listing). New actions document:upload / upload_listing / delete / read_private, knowledge:read / manage. Cron
  /api/cron/documents (5 min, maxDuration 300 — needs fluid compute): Resend attachments → documents; unpdf / mammoth /
  plain text; scans and photos → Claude vision (packages/ai `document-read@v1`, ai_run feature `document-read`, per-agency
  cap DOCUMENTS_VISION_DAILY_BUDGET_USD_PER_AGENCY); chunks embedded within the indexing cap. Assistant: search_documents +
  read_document (D references), prompt `assistant@v25`. UI: contact Documents tab, "Property documents" on both listing
  edit pages, /knowledge + /my-knowledge (nav), drag-and-drop uploader, the panel's `documents` frame.
  Checks: core 1274 pass (3 fail = the pre-existing Windows path/CRLF tests, confirmed on a stash); ai 312 pass (2 fail =
  the pre-existing time-zone recent-sales tests); auth, ui green; typecheck core/ai/console/web clean; lint 0 errors; web +
  console builds OK; the entrypoints route check passes with paths normalised for one local run. Smoke check NOT written;
  TEST-PLAN **BG**; DEPLOY.md "Documents and the knowledge base" + inbound steps.
  **Next:** the user sets Resend + env, walks BG. Feature 2 (opportunities, 0062) is being built.
- **Admin dashboard: online, email, user block (ADR 0052, 2026-10-21) — committed, pushed and MERGED into `main` at the user's word.**
  Online = `user.last_seen_at` within 5 min (console `/api/live` + site `PresencePing`, ≤ 1 write/min). Dashboard:
  agencies/agents/users with online/suspended/blocked, online now, newest agencies/members/users. `/emails`: write to
  one agency (owners+admins), member, user, or every agency/agent/user — recipients resolved server-side and frozen,
  first 25 sent at once, the rest by the minute cron. Block a site user: `user.blocked_at` + Supabase ban; the site
  treats them as signed out; alerts stop. **Migration 0060 APPLIED 2026-10-21 before the merge (61 recorded; RLS on,
  no grants).** The user adds SUPABASE_SERVICE_ROLE_KEY to the admin Vercel project and tests email by hand. All new SQL run on the real DB inside a rolled-back transaction (OK). Checks: core
  platform tests 189 green; break-test red (member guard on user block); typecheck 9/10, lint 0 errors; console +
  web builds OK. TEST-PLAN **BF**. Smoke not run.
- **Platform admin (ADR 0049 + 0050 + 0051) — MERGED into `main` (fast-forward) and pushed 2026-10-21 at the user's
  word, which deploys it.** Smoke run once (SMOKE_ENABLED=true for the run only): Platform admin 2/2 (break-test red),
  Console signed-out 23/23, Tenant isolation 4/4. Still the user's: the Privacy Policy paragraph and TEST-PLAN BC, BD, BE. **Migrations 0057, 0058 and
  0059 are APPLIED** to the Sydney database (60 recorded; RLS on, no grants on the three new tables). The dev admin
  account exists; its address and password are not recorded in the repo and must be replaced before production.
  Merging deploys to production at once (public-site tracking + the privacy paragraph go live); the admin console
  needs the `admin.` domain and `NEXT_PUBLIC_ADMIN_URL` on Vercel (DEPLOY.md). Smoke not run (SMOKE_ENABLED=false).
  **Next:** a Vercel project for the admin console (CONSOLE_SURFACE_OVERRIDE=admin); replace the admin credentials; walk BC/BD/BE.
- **Users, site activity, email activity, new admin home (ADR 0051, 2026-10-21) — `feat/platform-admin`, committed (see above).**
  Tracking: `site_activity` (0059) written by `/api/activity` from an `ActivityBeacon` on /search (page 1) and
  /listing/[id] — signed-in by account with filters, anonymous counts only; privacy page updated (owner to review).
  Admin: /users, /users/[id] (+ guide chats), /site-activity, Email activity tab (agency + member), home with
  needs-attention + leads/week + interest bars, profile headers, shell top bar under 900 px.
  **Migrations 0058 and 0059 APPLIED 2026-10-21 (60 recorded).** All new SQL run against the real DB inside a rolled-back
  transaction (OK). Checks: core platform tests 85 green; break-tests red (anonymous filters kept; last-owner);
  typecheck 9/10 (config old), lint 0 errors. TEST-PLAN **BE**.
- **Admin controls (ADR 0050, the user's pick 2026-10-21) — built on `feat/platform-admin`, committed (see above).**
  Suspend/reactivate an agency (console login refused via `accessBlock` in load-actor; listings off the public
  site via `publicListing()`; workflows/skills/scheduled steps/imports/bulk email skip it via `SUSPENDED_AGENCY_IDS`),
  plan + trial end, block/unblock a member (status suspended WITHOUT removed_at; may not register a new agency),
  make owner. `platform:manage`; every change → `platform_action` in the same transaction. Controls on the agency
  Overview, Access on a member's page, "Changes by the platform" table.
  **Migration 0057 APPLIED 2026-10-21 with the user's go (58 recorded, RLS on, no grants); the dev admin account created
  and a real Supabase sign-in checked.** **Migration 0058 APPLIED 2026-10-21.**
  Checks: core platform tests (41 + 18) green, break-test red (last-owner guard); core typecheck, console typecheck,
  lint 0 errors. Smoke check "agency control…" written, not run (smoke off; needs 0058). TEST-PLAN **BD**.
  **Next:** walk BC + BD (see the top entry).
- **Platform admin console (ADR 0049, asked 2026-10-20) — built on `feat/platform-admin`, committed (see above).**
  New surface `admin.*` (same console app; `CONSOLE_SURFACE_OVERRIDE=admin` also works): /platform (figures),
  /agencies (all agencies → profile with tabs Agents, Leads, Customers, Inbox, Meetings, Listings, Team messages,
  Workflows), /agencies/[id]/agents/[userId] (that member's own view + Assistant chats), /agents (everyone).
  Read-only by construction: `platformViewActor` builds an owner/member actor with `via: 'platform'`, and can()
  refuses every action outside `PLATFORM_READ`. The user chose: admins read everything (team messages, assistant
  chats, private notes) and every page is logged (`platform_view_log`, fail-closed). Admin = row in `platform_admin`,
  made by `PLATFORM_ADMIN_EMAIL=… PLATFORM_ADMIN_PASSWORD=… pnpm --filter @repo/db db:platform-admin`.
  **Migration 0057 APPLIED and the dev admin account created 2026-10-21 (see the entry above).** The user asked
  for a dev admin account on a public-mail address with a short password (not recorded here) — told them the address may be someone else's (reset-link takeover) and the password is guessable; fine for dev, change before production.
  Checks: core platform tests 41 green; break-test red (read-only guard removed → 13 red); typecheck 9/10
  (`@repo/config` failed before); lint 0; console build OK; local `next start`: admin host signed-out → /login,
  /signup → /login, login copy "Platform Admin". The subquery test caught a real bug (bare "id" in single-table
  selects), fixed. can-matrix parser fixed for CRLF (it was silently parsing 6 actions on this machine).
  Smoke group "Platform admin" + admin rows in "Console (HTTP, signed out)" written, NOT run (SMOKE_ENABLED=false;
  the DB group also needs 0057). TEST-PLAN **BC**.
  **Next:** walk BC (see the top entry).
- **Automatic emails to new leads, filtered and timed, from the chat (ADR 0048, asked 2026-10-20) — built on
  `feat/workflow-filters`, since merged into `main`.** On top of ADR 0041's workflows: conditions `contact.name` (whole name, or
  `contains`), `listing` (P refs), `listing.near` (N km of a place the SERVER geocodes — the model only names it);
  action `wait_until` (a time, or a window + weekdays, on `agency.time_zone`, DST-safe); new card `create_template`
  (exact words, `createTemplate`). On/off was already there (Workflows screen, `change_workflow`). Prompt
  `assistant@v24`. **Migration 0056 (tool CHECK + `create_template`) APPLIED 2026-10-20 with the user's go (checked: 57 recorded, CHECK has create_template).**
  Checks: typecheck core/ai/console OK, lint 0 errors, new unit tests green; 3 break-tests red (window ignored,
  "contains" rule removed, template permission removed); the red-team test caught a model field named `to` → `time`/`until`.
  **Failing before this work, on this Windows machine, untouched files:** core isolation/subquery tests (backslash
  paths), ai recent-sales dates (machine zone), `@repo/config` typecheck (no @types/node — the uncommitted
  package.json/pnpm-lock changes). TEST-PLAN **BB**. **Smoke "Workflows" 7/7 green (2026-10-20, DATABASE_URL=DIRECT_URL;
  over the 6543 pooler one old check dropped its connection)**, incl. the new ADR 0048 check = BB1/2/4/6/7 without a
  browser (template card → Approve; Parramatta + 9 am card → Approve; 8 pm lead → email due 09:00 next morning; Bondi no
  run; 5 km radius; pause/resume). Break-test red (window ignored → step ran at 8 pm). NOT checked: the screens and the
  live model's choices (no browser here; no paid run).
  **Next:** the user walks BB; push/merge with their go.
- **Console assistant answers showed raw Markdown (`**`, `- `) — fixed 2026-10-16 on `feat/dashboard-update`, committed.**
  The answer went into one pre-wrap div. Now `components/assistant/rich-text.tsx` renders it through the shared
  `@repo/core/markdown` parser (the web chat's): paragraphs, lists, bold/italic/code, heading lines. React elements only,
  no HTML. Lint 0 errors, unit green, console build OK. TEST-PLAN **BA**.
- **Console sign-out did nothing — fixed 2026-10-16, pushed with the user's go (with ADR 0047 and the map fix).**
  `/sign-out` was a Server Component page: `signOut()` could not write cookies, the throw was swallowed by `setAll`'s
  catch, the session survived and /login bounced back in (production checked with the Harbour test owner: 0 cookies
  cleared). Now a POST route handler (GET → `/`, signs nobody out), every sign-out link a form (`SignOutButton`), `next`
  relative only. Verified on a local `next start` with a real sign-in: POST clears the cookie, /leads → /login; GET and
  `next=//evil.example` harmless. Smoke check added to "Console (HTTP, signed out)" (not run, at the user's word);
  isolation test lists the route as public. TEST-PLAN **AZ**.
- **Map: units at one point could not be chosen — fixed 2026-10-16, pushed with the user's go.**
  1/14 and 2/14 Henry St (and any building's units) share one geocode: one marker each sat exactly on top of the
  other, so only the top one was clickable, every marker had its own never-closing InfoWindow, and fitBounds on one
  point dove to max zoom. `packages/ui/src/maps`: `groupPins` (≤ 3 m = same spot) → one marker with a count and a popup
  listing each pin as a link; one shared InfoWindow; popup built with textContent (labels were interpolated as raw
  HTML); fit capped at zoom 18. Pin placing (editable) unchanged, and keeps the agent's zoom. New `@repo/ui` vitest
  suite (4, in root `pnpm test`; break-test red). Typecheck 10/10, lint 0 errors, unit 1135 + 307 + 9 + 4, web +
  console builds OK. TEST-PLAN **AY**. **Next:** walk AY.
- **ADR 0047 built on `feat/dashboard-update` 2026-10-16 (the user's request: change a project in the chat that made it;
  new chat = new project; colours on request; proper responsive tables).** `update_dashboard` (card → `updateDashboard`,
  `dashboard:manage` again, refused if changed since the card), tiles kept with `{ keep: n }`; `create_dashboard` refused
  in a chat that already saved one unless `separate`; "this chat's dashboard" = its done create card (`chatDashboards`).
  `dashboard.theme` `{ colors }` → `--chart-1…6`; pale colours refused. Tables stack under 640 px, wide tiles span the
  grid (ARCHITECTURE §2 "Dashboards: colour, layout and tables"). Prompt `assistant@v23`. **Migration 0055 (theme column +
  tool CHECK) APPLIED 2026-10-16 (the user ran db:migrate; checked: 56 recorded, `dashboard.theme` exists), then merged + pushed.**
  Checks: typecheck 10/10, lint 0 errors, unit 1135 (+13) + 307 + 9, console build OK; break-tests red (manage check,
  stale check, one-chat refusal). New smoke check "ADR 0047 …" (Dashboards group) written, not run (needs 0055).
  TEST-PLAN **AX**. Smoke skipped at the user's word (they test live). **Next:** the user walks AX on production.
- **ADR 0046 built on `feat/session-claims` 2026-10-16, committed, NOT pushed (the user's go).** Middleware `getUser()` →
  `getClaims()`: the ES256 access token is verified locally (JWKS cached 10 min), expired sessions still refresh, an HS
  key would fall back to getUser. `SessionResult.user` = `{ id, email, label }`. Checks: typecheck 10/10, lint 0 errors,
  unit 1122 + 307 + **auth 9 (new package suite, in `pnpm test`)**, console + web builds OK; break-tests red (no
  signature check; back to getUser; no header strip); real Supabase sign-in against a local `next start`: 200 signed in,
  forged header → /login; smoke signed-out 16/16. Trade-off (in the ADR): a session revoked elsewhere passes middleware
  until its token expires; the console's own membership check still refuses a removed member. TEST-PLAN **AW**.
  **Next:** merge + push with the user's go; walk AW.
- **Nav clicks that did not register — fixed on `fix/console-polling` 2026-10-16, committed, NOT pushed (the user's go).**
  LiveRefresh (5 s), the bell (1 min) and the inbox's mail pull (20 s) polled by Server Action; a click during one made
  Next discard it and force a refresh that empties the Router Cache (next 15.5 `app-router-instance.js`), so returning to
  a page meant 2–3 s of nothing. Now `GET /api/live`, `GET /api/notifications`, `POST /api/mail/sync` (same core calls,
  401 without a session); `liveStampAction`, `listNotificationsAction`, `syncMailAction` removed. Nav items show a ring
  while their page loads (`useLinkStatus`). ARCHITECTURE §3 "A poll is a fetch". Checks: typecheck 10/10, lint 0 errors,
  unit 1122 + 307, console + web builds OK; smoke "Console navigation" 1/1 (break-tests red: an action in the bell's
  `load`; and main's old code → names all three polls), "Console (HTTP, signed out)" 16/16 incl. the three routes.
  TEST-PLAN **AV**. **Next:** merge + push with the user's go; walk AV.
- **Functions moved to Sydney (`syd1`) 2026-10-16 (`49eca64`, pushed + deployed with the user's go).** All three
  Vercel projects ran in `iad1` (Washington) while the DB is `ap-southeast-2`: ~200 ms per query, several per console
  click. `regions` in `apps/web/vercel.json` + new `apps/console/vercel.json`; DEPLOY.md says why. No Zustand: the
  user agreed it is not needed if the region fix gives the speed (ARCHITECTURE §4 stands).
  **ADR 0046 PROPOSED** (not built): middleware `getUser()` → `getClaims()` (local ES256 check, refresh kept, HS
  fallback). **Next:** the user feels the console after the deploy; then build 0046 with its break-test + smoke.
- **Integration 2026-10-16: on `main`, PUSHED and DEPLOYED with the user's go (`a474665`); all three Vercel production
  projects (agent, agencyy, users) Ready.**
  `main` = origin/main (ADR 0042 + 0043, deployed) + ADR 0044 (`4e742d3`) + the one console shell (ADR **0045**, renumbered
  from a second "0041"). The shell work had sat uncommitted on `feat/assistant-tasks` since 2026-10-14; a snapshot of its
  agency half was already on main (`5cb8107`). Rebased onto main: both consoles use `components/shell/console-shell.tsx`
  + `surfaces.ts`; the agent desk's home is `/assistant` (middleware + `lib/surface.ts`), Projects at `/my-projects`
  (`/my-dashboards` redirects); the floating `AssistantPanel` is gone. Kept from main in the merge: Workflows in both
  navs, the import frame, Connect buttons, skill/workflow/listing links, `invite_agent`, the open-answer tile (0042) and its
  thumbnail shape, ADR 0043's template wording. No migration, no new endpoint. Checks on the merged tree: typecheck 10/10,
  lint 0 errors (1 old web `<img>` warning), unit 1122 + 307, console + web production builds OK. NOT run: smoke (off
  by default; the user runs it) and the browser walk — TEST-PLAN **AU** (both consoles) + AT.
  **Deliberately NOT merged:** `feat/crm-visibility` and `feat/crm-assistant-more` (2026-10-08/09). Later decisions
  replaced them — ADR 0039 A (nothing deleted for good) vs their contact delete + purge; ADR 0039 C (an agent also sees
  leads on listings they listed) vs "nothing through a listing"; ADR 0043 (no template approval) vs approval — and their
  migrations 0038/0039 clash with main's. Their 0038 (`lead_handover`) / 0039 were applied on dev back then: those objects
  may still be in the database, unused by main. `packages/smoke/src/test-accounts.ts` stays untracked (holds a password).
  **Next:** walk AU (both consoles) + AT on production; smoke when the user chooses.
- **Requests of many parts, one dashboard (ADR 0044, asked 2026-10-16) — built on `feat/complex-dashboards` (from
  `feat/email-rules`), committed on main (`4e742d3`), NOT pushed. Migration 0054 APPLIED 2026-10-16 with the user's permission (dev =
  production DB). ORDER on deploy: 0054 is in; main's code ignores the new view columns.** Prompt `assistant@v22`: list every item,
  map it to a dataset or "not held", one view per grain, build, then ONE create_dashboard with `coverage` (card lines "You
  asked for: …"). New datasets `sales`, `lead_responses` (email response time); agents + licence number/class/expiry. Fan-out:
  taught (one CTE per activity) + a per-agent result naming an agent twice is refused. Error hints for the model. Caps raised
  (query 12,000 chars, 24 columns, 30 tool calls, 32k output tokens per analysis round, 150 queries/hour); locks unchanged.
  New tile `figures`. Also fixed: the Dashboards smoke check that looped over `open` without a query (failed since 0042).
  Checks: typecheck/lint 20/20, unit 1122 + 307, console build OK, break-tests red. Smoke "Open questions": the ADR 0044
  check green (every hand-worked figure; the fanned-out query gives 3,600,000 vs 900,000); I1's wall-clock budget (7.5 s for
  a 5 s timeout) is network-flaky from here (7.9 / 6.9 / 7.5 s), not from this work. Live eval (`SMOKE_ONLY="Many parts,
  live" pnpm smoke:ai`, its own group) green once: 4 tool calls, 1 query, coverage 6 items, commission not held, a1's row
  exact. TEST-PLAN **AT**. **Next:** push with the user's go; walk AT; more live samples before calling it reliable.
- **Templates without approval, consent from an enquiry, no 7-day rule (ADR 0043, the user's decisions 2026-10-14) — built on
  `feat/email-rules`, pushed to origin/main (`89157de`). Migration 0053 APPLIED with the user's permission.** A template is ready when saved
  (an agent's: theirs only; an owner's/admin's: the agency's); consent = recorded, OR an enquiry in 24 months, OR a
  seller/landlord/tenant role; an unsubscribe always wins; the 7-day rule is deleted (batch size and daily caps stay). Prompt
  `assistant@v21`. Unit 1410 green; smoke Template email 7/7, Workflows 6/6, Tenant isolation 4/4, Assistant part 2 5/5,
  Console assistant: every check green in at least one of two runs (the rest were network drops); one old time-of-day bug in
  a task check fixed. TEST-PLAN **AS**. **Next:** push/deploy with permission; the user walks AS; a lawyer confirms the
  24 months and the client roles once.
- **Open questions on the agency's data (ADR 0042, accepted 2026-10-14) — built 2026-10-14 on `feat/open-analytics` (from main),
  pushed to origin/main (`24d2dd4`). Migration 0052 APPLIED 2026-10-14 with the user's permission.** The assistant writes ONE read-only
  SELECT over 9 named datasets (`describe_data`, `query_data`), run as the person behind four locks (parser; the screens' scope
  helpers; role `ai_reader` on the `ai` schema's ticket-filtered views; a read-only 5 s transaction). Answers in chat and saved
  tiles via `widget: "open"`; nobody dropped from per-agent tiles; other people's words never reach the model. Prompt
  `assistant@v20`. Unit 1404 green; smoke "Open questions (ADR 0042)" 5/5 green; console + web build trace the parser's wasm.
  TEST-PLAN **AR**. **Next:** the user walks AR in the browser; then push/merge with permission.
- **DEPLOYED 2026-10-14 (the user's permission):** `main` fast-forwarded to `5cb8107` — assistant Phase 2 (both parts),
  Phase 3 imports (Sheets by Picker, Excel, contacts), Phase 4 (skills, workflows), and the "Console UI: the assistant as the
  agency home…" commit (made by another session on `feat/workflows`, NOT covered by the full smoke run; its typecheck/lint and
  the Vercel builds pass). All three Vercel production deployments Ready; migrations 0047–0051 applied. Full smoke before the
  push: 245 pass, 7 fail — none from this work (4 HTTP checks hit the local DEV server, the known inbox test, two old
  team routes without loading.tsx, a check reading the removed .github cron file). **Next (the user):** Google Cloud setup
  (TEST-PLAN AO), walk AM–AQ in the browser.
- Milestone: **M6 — email conversations live in the app (ADR 0016).** Every lead
  is a conversation an agency can read and answer in the console; buyers read
  theirs on the website; replies from Gmail land back in the same thread.
  Built on M5 (sold properties, private offers, the lead inbox).
- **Phase 4 Parts B–C — workflows (ADR 0041) — built 2026-10-14 on `feat/workflows` (on top of `feat/assistant-skills`),
  committed, NOT pushed. **Migration 0051 APPLIED 2026-10-14 with the user's permission (52 rows)** — required for this branch
  (core functions write `workflow_event`); main's code ignores the new tables.** Catalog, outbox events, engine on the minute cron, AI drafts as cards (never sent), manage + permissions,
  assistant `find_workflows` / `create_workflow` / `change_workflow` (prompt `assistant@v19`), Workflows page. Smoke group
  "Workflows (ADR 0041)" 6/6 green (2026-10-14) after two fixes it found: events now take `clock_timestamp()` (one transaction
  shared `now()`), and a draft step that cannot write a draft is FAILED with the reason, not silently done. TEST-PLAN **AQ**.
  **Next:** walk AP/AQ in the browser; decide push/merge of the stacked branches.
- **Phase 4 Part A — skills by the assistant (ADR 0041, accepted 2026-10-14) — built on `feat/assistant-skills`
  (on top of `feat/sheets-import`), committed, NOT pushed. **Migration 0050 APPLIED 2026-10-14 with the user's permission (51 rows).** `find_skills`,
  `set_up_skill`, `change_skill` (cards over the ADR 0021 skills code), prompt `assistant@v18`. Smoke group
  "Assistant skills (ADR 0041)" 1/1 green (2026-10-14). TEST-PLAN **AP**. **Next:** Part B — the workflow engine (ADR 0041).
- **Phase 3 — imports (ADR 0029 amendment, ADR 0039 Phase 3) — built 2026-10-13 on `feat/sheets-import`
  (on top of `feat/assistant-crm-2`), committed, NOT pushed. **Migrations 0048 + 0049 APPLIED 2026-10-14 with the user's permission (50 rows; dev = production DB).**
  Google Sheets by the Picker (`drive.file`; pasted-link route PENDING Google verification), Excel (.xlsx)
  uploads, contacts import (CSV / Excel / Sheet; same email skipped; consent never imported), assistant
  `start_import` (prompt `assistant@v17`). Found: uploads were capped at 1 MB by the Server Action default —
  now 4 MB everywhere (Vercel's 4.5 MB limit). Checks: typecheck/lint 20/20, unit 1014+ / 302, break-tests red.
  Smoke "Imports: contacts and Google Sheets" 3/3 and "Assistant part 2 (ADR 0040)" 5/5 green (2026-10-14). TEST-PLAN **AO** (lists the Google Cloud
  setup: Picker/Sheets/Drive APIs, `drive.file` on the consent screen, `GOOGLE_PICKER_API_KEY`,
  `GOOGLE_CLOUD_PROJECT_NUMBER`). Onboarding photo "10 MB" checked: correct (signed upload straight to Storage).
  **Next (the user):** Google Cloud setup + env on Vercel, walk AN/AO, then decide push/merge to main.
- **Assistant Phase 2, part 2 (ADR 0040) — built 2026-10-13 on `feat/assistant-crm-2` (on top of
  `feat/assistant-tasks`), committed, NOT pushed. Migration 0048 written, NOT applied** (dev = production DB).
  Connect button everywhere (`needs_connection`), template email to a saved list (F refs; > 20 → one card,
  parts of 20 a day, retry +1 h over the daily limit), `invite_agent`, listings (`create_listing_draft`,
  `update_listing`, `withdraw_listing`, `submit_listing` — never publish), prompt `assistant@v16`;
  `listing:create` now refuses read-only members. Checks: typecheck/lint 20/20, unit 989 + 301, 5 break-tests
  red. Smoke: 5 checks written (before "New email and team messages"), NOT run — the user stopped the slow run;
  3 need 0048. **Smoke is OFF by default now** (`SMOKE_ENABLED=false` in .env.local). TEST-PLAN **AN**.
  **Next:** user applies 0048; Phase 3 (Google Sheets via Picker `drive.file`, XLSX, contacts import,
  assistant import) — the pasted-link route is pending.
- **Team meetings (ADR 0038) — built 2026-10-12, merged to `main`. Migration
  0044 applied on dev 2026-10-12.** Internal meetings between members, no contact: Calendar →
  **+ Team meeting** (1–10 colleagues, Zoom / phone / in person, agenda, reminder; admins pick a
  host) and the assistant's `schedule_team_meeting` (prompt `assistant@v12`). Book → Zoom → every
  colleague gets a bell + email with the join link and an `.ics`; moves and cancels tell them too;
  a colleague may decline ("Can't make it", host told); reminders reach every colleague still
  coming; nobody on it can be double-booked (advisory locks + check); admins see them in full;
  client widgets leave them out. Also fixed on the way: the team thread / skills subquery bug
  (`87dc7b1`, on main). Checks: typecheck 10/10, lint 0 errors, unit 943 + 296, console + web
  builds OK; permission break-tests red. Smoke group "Team meetings" (4) written, NOT run.
  TEST-PLAN **AL**. **Next (the user):** `SMOKE_ONLY="Team meetings" pnpm smoke` (+ Appointments,
  Offboarding, Console assistant), deploy, walk AL.
- **Zoom deauthorization + legal pages (ADR 0037) — on `main` 2026-10-12. Migration 0043 applied
  on dev** (`integration_account.external_account_id` = Zoom user id from `/users/me`, + index).
  `POST /api/zoom/webhook` on apps/web: `x-zm-signature` (Secret Token `ZOOM_WEBHOOK_SECRET_TOKEN`,
  web project) → URL validation answered; `app_deauthorized` deletes every Zoom row of that Zoom
  user (own + agency); unsigned 401, no secret 503. `/privacy-policy` and `/terms-of-service` on
  apps/web with bracketed placeholders in `app/(legal)/legal.ts` (draft text, needs a lawyer).
  Checks: typecheck 10/10, unit 929 + 296, web build OK, 4 break-tests red. Smoke check written
  (Integrations group), NOT run — the user runs live tests. Zoom Development rows connected
  before 0043 have no id: reconnect. Dev `ZOOM_OAUTH_RETURN_BASE` points at the Vercel console,
  which breaks connecting from local dev (use a tunnel). **Next:** user fills legal.ts, sets the
  Secret Token, validates the endpoint in Zoom, walks TEST-PLAN AK, submits the Zoom app.
- **Note:** ADR 0035 and 0036 are committed on main (4bf0828, bd02f18) and 0041 + 0042 are
  applied on dev; the two bullets below predate that.
- **Assistant Phase 2, part 1 (ADR 0040) — built 2026-10-13 on `feat/assistant-tasks`, committed, not pushed.**
  **Migration 0047 applied** (dev = production database — verified 2026-10-13 by comparing hosts). Tasks:
  plan_task (≤ 10 steps, 30 days, approved once on one plan card with exact third-party text), steps as
  `blocked` proposed_action rows run by the minute tick as the approver, stop on failure, read-back after
  each step; create_reminder (bell; own email only if asked); cancel_task. CRM: find_listings, set_lead_status,
  assign_lead (admins), create_lead (manual, own listings), create_contact. Website enquiries auto-assigned
  to the listing's lead agent; a reassigned agent is told "This lead is now with another agent…". Fixed:
  background actor lacked listing links. Prompt `assistant@v15`. Checks: typecheck/lint 10/10 (0 errors),
  unit 974 + 301, console build OK; smoke Console assistant 29/29 (+1 skip), Database health 23, Contacts 12,
  Tenant isolation 4, Offboarding 6, Listing import 4, Template email 6; break-tests red (stop-on-failure,
  release-one-step, plan-reject ends task; read-back unit). Still failing, pre-existing: Email conversations
  "agent's inbox holds only their own leads' conversations" (live-data assumption). TEST-PLAN **AM**.
  **Next:** push + deploy (user's go), then Phase 2 part 2.
- **Assistant Phase 1 (ADR 0039) — on main and deployed 2026-10-13 (22c6524).** `main`
  locally = merge of `feat/semantic-layer` + origin/main (1801a1b), not pushed. Migration **0046 applied on dev**
  (proposed_action.reported_at, mail_message.send_started_at / send_attempt). The model is told how its cards
  ended (`<card_updates>` + `check_cards`, prompt `assistant@v14`); one email once (claim before send, Resend
  Idempotency-Key, Gmail never resent after a crash, Retry = new try, sweeper in the 5-minute tick). Decisions
  A–D recorded in ADR 0039 (no hard deletes; whole-app Google + uploads; lead visibility and auto-assign;
  agents' own powers). Checks: typecheck/lint 10/10 (0 errors), unit 970 + 301, console build OK; smoke Console
  assistant 25/25 (+1 skip), Template email 6/6, Appointments 6/6; break-tests red (claim, reported mark,
  idempotency key, unreport). **Known, not from this work:** smoke "an agent's inbox holds only their own
  leads' conversations" fails on merged main too — it reads live dev data and counts only lead threads, but
  the inbox now also holds contact (lead-less) threads (ADR 0018/0035). TEST-PLAN **AL**. **Next:** push main +
  this branch (deploys), then Phase 2 (task ADR first).
- **Dashboards from any request — ADR 0036 Phases 1–4 built 2026-10-12; merged into local `main` 2026-10-13.** Migration **0045 (`dashboard_gap_log`) applied on dev with the user's permission (46 rows).** Semantic layer in
  `packages/core/src/semantic/`: catalog (sales, listings, leads, appointments, emails, contacts), strict
  spec, one-statement compiler (scope first, ids from the catalog, values as parameters, no `sql.raw`),
  standard full-page report. The six fixed widgets are presets now (parity with the old SQL: smoke, 80
  figures). `custom` widget; assistant `assistant@v13` with the catalog, `show_widget`/`create_dashboard`
  take `{ widget: 'custom', spec }`, `report_missing_data` → gap log. Evals: 14 phrases (offline validity;
  live only in `pnpm smoke:ai`). Checks: typecheck/lint 10/10 (0 errors), unit 967 + 298, console production
  build OK; smoke Dashboards 9/9 (+1 skip, console not running) incl. presets parity (80 figures), I9 over two
  agencies (88 figures unchanged, 63 counts agent ≤ admin), the assistant's custom card + gap log. Break-tests red:
  scope, sql.raw, dimension permission (unit); contacts' agency filter dropped → I9 "B changed 5 of A's figures"
  (smoke). TEST-PLAN **AK**. **Next:** merge to main + push, then walk AK.
- **New email + team messages + assistant writing (ADR 0035) — built 2026-10-12 on
  `feat/compose-email`, NOT committed. Migration 0041 written, NOT applied (user: "abhi nahi").**
  Agents/owners write a NEW email to a contact (`/inbox/new`, `/my-inbox/new`, contact Emails tab;
  `mail:compose` = contact:update; refused if unsubscribed/archived/no email/limits/dev allowlist;
  carries the contact's unsubscribe link; own Gmail when connected). Team messages between members
  (`/messages`, `/my-messages`, nav badge, bell + email to the others, reply-by-email via signed
  `m+` address with DMARC; only the people on it read it, not admins; read-only reads only).
  Buyers: `/account/messages` shows a New pill until opened. Assistant: `find_colleagues`,
  `send_email`, `message_colleagues` (card = exact words + "Check these figures"; prompt
  `assistant@v11`). Checks: typecheck 10/10, lint 0 errors, unit 909 + 296, console + web
  production builds OK; 5 unit guards broken → red. 4 smoke checks written ("New email and team
  messages"), NOT run — they need 0041. TEST-PLAN **AI**. **Next:** apply 0041
  (`pnpm --filter @repo/db db:migrate`), run `SMOKE_ONLY="New email and team messages" pnpm smoke`
  and the "Console assistant" group (its AE tool-CHECK check needs 0041), then commit and walk AI.
- **Dashboards semantic layer (ADR 0036) — ACCEPTED 2026-10-12; Phase 0 built on `feat/compose-email`
  (on top of ADR 0035's uncommitted work), not committed.** Migration **0042 written, NOT applied**
  (repair duplicate lead agents → `listing_agent_lead_idx`; indexes `listing_agency_status_sold_idx`,
  `mail_message_agency_created_idx`; needs 0041 first). Built: `listingScopeFilters` + `listing:read_all`,
  `contactScopeFilters`, one email owner (`mail/owner.ts`; "Replies by agent" changes on purpose —
  TEST-PLAN AH11), `leadAgentIdSql` (lowest display order), `ACTIVE_LISTING_STATUSES`,
  `withReadTimeout` (3 s + read-only, rolled back; new tile state `too_slow`). Checks: typecheck
  10/10, lint 0 errors, unit 922 + 296, break-tests red; repair tested on PGlite. Smoke written, not
  run. **Next:** dry-run query in TEST-PLAN AJ → apply 0041 + 0042 → `pnpm smoke` → walk AH11 + AJ →
  commit; then Phase 1 (compiler + four datasets, presets with a parity check).
- **Agents widget (ADR 0034) — committed 59cfc03, on `main` and pushed.**
  No migration. Owners/admins ask the assistant "create a dashboard with all agents' names and the
  emails they received today" → a create_dashboard card with the new `agent_activity` widget → on
  Approve, a link to `/dashboards/<id>`: every active member (0s kept) with emails received / sent /
  failed, waiting for a reply, new leads, appointments, active listings, contacts, latest email; the
  full page lists each person's emails (subject, from/to, snippet, link to the inbox). Received =
  the lead's agent, else the contact's agent; sent = `sent_by`. Prompt `assistant@v10`. Checks:
  typecheck/lint 10/10 (0 errors), unit 898 + 296, smoke Dashboards 4/4 (+1 skip, console not
  running); 4 break-tests red. TEST-PLAN **AH**. **Next:** walk AH.
- **Meetings end to end (ADR 0032) — built 2026-10-10; committed 79f2f10 on `feat/meetings`,
  merged with team edit (ADR 0033) and on `main` at c9fd9b7.** Migration **0039 applied on dev** (btree_gist; EXCLUDE
  `appointment_agent_no_overlap` on (assigned_agent_id, tstzrange) for active rows;
  `appointment.reminder_sent_at`; table `notification`, RLS on). What it does: the assistant's
  booking card can also email the invitation (`send_invitation`; approve → book → Zoom sync →
  ADR 0019 template with the join link); Google Calendar is optional for booking; one agent
  can't be double-booked (core names the clash, the constraint stops races; offboarding queues a
  clashing appointment instead of failing); reminders 15 min before by default (cron tick):
  console bell + email to the assigned agent and the booker, email to the contact if invited;
  "Upcoming meetings" on /overview and the agent's /listings; website `/account/meetings`
  (invited meetings with Join, starting-soon banner, latest emails). Prompt `assistant@v8`.
  Checks: typecheck 10/10, lint 0 errors, unit 871 + 296, console + web production builds OK;
  smoke Appointments 6/6, Offboarding 6/6, Console assistant 23/23 (+1 skip). Full smoke:
  155 pass, 4 fail, 76 skip; of the 4, two are fixed and re-run green (reminder Date binding,
  assistant C's old "Calendar required" rule), and two were already failing before this work
  (no loading.tsx for team/remove and team/removed; the smoke reads
  .github/workflows/alerts-cron.yml, which d1d804d deleted). TEST-PLAN **AF**.
  **Next:** deploy console + web from main, then walk AF. Dev DB has 0039 and 0040; a
  deployment of code older than c9fd9b7 shows a raw error on an overlapping booking.
- **Assistant search (ADR 0031) — merged into `feat/crm` 2026-10-07.** Migration
  0036 applied on dev (generated full-text columns on note / mail_message / lead with GIN indexes;
  `search_embedding` with pgvector 1024 + HNSW, RLS). New read tool `search_notes_and_emails`
  (≤ 8 results, contact reference + kind + date + ≤ 200-char `untrusted_snippet`); permission in
  the SQL via the screens' own rules; archived contacts only when named. Full-text always, no key;
  embeddings only with EMBEDDINGS_PROVIDER=voyage + VOYAGE_API_KEY (cron tick + `pnpm --filter
  @repo/ai search:backfill`), never for private notes, archived/opted-out contacts or offers.
  Metered in ai_run (question inside the assistant caps; indexing cap 0.25/agency/day). Prompt
  assistant@v6. TEST-PLAN AD; TEST-ORDER Block 3b. Client questions in ADR 0031.
- **Merged 2026-10-07: polish → search (rag) → assistant contact tools, on `feat/crm`.** Migrations
  0036 (search) and 0037 (contact tools) both already applied on dev; prompt `assistant@v7` carries
  v6's search text. After pulling: `pnpm install` once, then restart `pnpm dev`. Next: TEST-PLAN
  in TEST-ORDER's order (now with Blocks 3b AD and 3c AE).
- **Every build phase is committed on `feat/crm` (2026-10-07)** — Phases 1–8: tenant
  isolation, assistant email card, dashboards, CSV import, Google reviews step 1, Gmail send,
  assistant run-later, offboarding. Migrations up to 0035 applied on dev. **Not built (by
  instruction): production / go-live** (domain, Vercel, Google verification, Zoom Marketplace,
  legal text — docs/DEPLOY.md), Google Sheets import, Reviews step 2. **Next: the user walks
  TEST-PLAN N → AC in the order of docs/TEST-ORDER.md.** Dev DB note: the transaction-mode
  pooler (6543) began closing long smoke transactions on 2026-10-07; run smoke with
  DATABASE_URL set to DIRECT_URL (session pooler) for that process if it recurs.
- **The assistant changes contacts (ADR 0025 amendment) — merged into `feat/crm` 2026-10-07.** Owners/admins: `find_team_members`
  (M references) and `assign_contacts` (≤ 20 contacts, card shows each one's email and current
  → new holder; agents are never shown the tools and core refuses them). Everyone who may edit
  the contact: `record_marketing_consent` (needs "how"; unsubscribed and already-agreed are
  skipped with the reason) and `withdraw_marketing_consent` (needs a reason); `update_contact`
  (name/email/phone/roles only, before → after from the DB, duplicate email → no card, stale
  card refused) and `set_contact_archived`. All "via the assistant" on the timeline; all re-
  checked at run (now and scheduled); offboarding cancels them. Prompt `assistant@v7`.
  **Migration 0037 (widens the proposed_action tool CHECK, no row change) applied on dev
  2026-10-07** with the user's permission (renamed from 0036 and dated after the search
  branch's 0036, so the two merge without renumbering). Smoke: Console assistant 24/24 (8 AE),
  Tenant isolation 4/4, Offboarding 5/5. Break-tests: 13, all red → green. Merge order: polish
  → rag → this; with rag, journal/docs/assistant files conflict textually (see SESSION).
- **Phase 8 — Offboarding (ADR 0030) committed.** Migration 0035 applied on dev (additive:
  membership.removed_at/by/report, needs_owner_at on contact/lead/appointment/listing,
  integration_account.connector_left_at, one active membership per person). Remove from the
  agency: the admin must choose a receiver or "leave for review"; the leaver's calendar
  events and own-Zoom meetings are deleted with their token first; one transaction moves or
  flags their work (private offers only ever to an owner/admin), cancels waiting/scheduled
  cards, prepared emails and imports, disables skills, deletes conversations, flags agency
  accounts they connected; then their tokens are revoked and deleted and moved appointments
  sync to the receiver. Undo for 30 days; "Needs an owner" queue on Overview; invites refuse
  a second agency. TEST-PLAN AC.
- **Phase 7 — Assistant Phase E, run later (ADR 0025) committed.** No migration (`run_at` and
  `scheduled` already existed). Behind `ASSISTANT_SCHEDULING=1` (off by default; needs the
  5-minute cron). The person picks the time on the card (≤ 48 h; an email card within its
  prepared batch's life); approve → `scheduled`; the cron tick runs each due action once
  (`FOR UPDATE SKIP LOCKED` claim and run in one transaction) as the approver as they are
  then, through the same code as Approve-now, so every check repeats; cancel until it runs.
  The card says "about … (up to 5 minutes later)". TEST-PLAN AB.
- **Phase 6 — Gmail send (ADR 0026) committed.** Migration 0034 applied on dev (provider
  `gmail` enum value; owner-type CHECK widened by DROP + ADD, no row change — flagged like 0031;
  agency.members_may_use_agency_gmail; mail_message.sent_via / sender_account_id). Sender per
  message: own Gmail → agency Gmail (admin switch) → platform; Reply-To stays the signed thread
  address; bulk template email and the relay never use Gmail; Gmail failure → failed with the
  reason and a "Send from the platform address instead" button (no silent fallback). Built
  against fakes; real Google needs the user's account: TEST-PLAN AA.
- **Phase 5 — Google reviews step 1 (ADR 0028) committed.** Migration 0033 applied on dev
  (agency_google_place: the place id only). Google's Places terms were checked first: only a
  place id may be stored, and Places content may not be cached. So, unlike the ADR's 6-hour
  cache, rating and reviews are fetched live each view and dropped. Settings → Google reviews
  (owner/admin picker, search ≤ 1/s), "Agency reviews" for agents, and a section on live
  listing pages loaded by the browser (never in ISR HTML), rate-limited, showing nothing when
  not set up. Attribution in one shared component, guarded by a test. "Link to contact" waits
  for step 2 (ADR decision). TEST-PLAN Z.
- **Phase 4 — CSV listing import (ADR 0029) committed.** Migration 0032 applied on dev
  (listing.external_id unique per agency; listing_import, listing_import_row). Upload (≤ 5,000
  rows, ≤ 10 MB) → match columns → dry run (form rules, geocoding outside transactions,
  duplicates by address / own id / earlier row) → row report (+ CSV download, formula-safe) →
  import in chunks of 100 under a 2-minute lease, driven by the open page and the cron tick
  (as the uploader, re-checked) → photos from links (SSRF-guarded on the socket itself).
  Owner/admin import live or draft; an agent's goes to approval; admin-only "Update from file";
  unknown agent email → under the uploader, flagged; file and cells cleared 30 days after.
  TEST-PLAN Y. Not measured: a 3,000-row run against the remote DB.
- **Phase 3 — Dashboards (ADR 0027) committed.** Migrations 0030 (agency.time_zone, dashboard)
  and 0031 (proposed_action tool CHECK widened for create_dashboard — no row change) applied
  on dev. Six widgets, Sold value with undisclosed sales counted apart, viewer-scoped figures,
  /dashboards and /my-dashboards lists, full-screen /dashboards/<id> polling with 304s, the
  assistant's show_widget and create_dashboard card. TEST-PLAN X. Found by smoke while
  building: the New leads widget's GROUP BY on a parameterised expression (fixed).
- **Phase 2 — Assistant Phase D committed:** "send an approved template to contacts I pick" card
  (ADR 0025 as-built D, TEST-PLAN W). `prepareBatch` takes a contact-id list; the card is a
  frozen ADR 0022 batch; Approve = ADR 0022 Approve + send with every re-check; Reject/Cancel/
  failure cancel the batch; directory checkboxes + "Ask the assistant". Platform sender only.
  **Next phase (not started): Dashboards (ADR 0027).**
- **Phase 1 — tenant isolation tests (ADR 0030) committed.** Unit (`packages/core/src/isolation/`):
  every table classified (22 own-agency, 10 through a parent, 4 shared, 6 public-site user —
  a new table fails until classified); every `can()` action (read from permissions.ts) × all
  six roles of A × a B resource rigged to look like theirs → refused; every route handler and
  server action reaches a session check or is public with a named guard; no door reads the
  user/agency from the request. Smoke "Tenant isolation" (two complete agencies, rolled back):
  116 reads (lists, getters, assistant read tools, selections) with no B id; 156 writes
  (contacts, notes, appointments, leads, mail, templates, batches, skills, tokens, assistant
  cards and forged-reference tools, listings) refused with B's 31 tables unchanged and 0
  emails; each agency's sync uses only its own Google/Zoom tokens and B's tokens never
  decrypt for A; the assistant's agency cap and conversations stay per agency. One real
  finding (below), fixed in its own commit. Not covered by smoke: admin / property-manager /
  assistant roles (the unit matrix covers them); route calls with a real browser session.
- **Fix found by the tenant-isolation matrix (2026-10-06):** `can(actor, 'listing:read',
  {type: 'listing', …})` returned true for a member of ANY agency (`|| membershipRole`). No
  leak in practice — every caller passed its own agency id and the SQL filters by agency — but
  the rule would have opened other agencies' drafts to the first caller that passed the
  listing's real agency. Now same agency + a membership. Unit and smoke unchanged otherwise.
- **ADRs 0026–0030: built** (2026-10-06/07), in this order: 1 tenant-isolation tests, 2 assistant
  email card (0025 D), 3 dashboards (0027), 4 CSV import (0029), 5 reviews step 1 (0028), 6 Gmail
  send (0026), 7 assistant run-later (0025 E), 8 offboarding (0030). Each ADR ends with "As built".
  Not built: Google Sheets import, reviews step 2 (Business Profile, Link to contact), go-live.
- **Polish (`feat/crm-polish`) — rebased on 1356053 and merged into `feat/crm` 2026-10-07:** invitation preview names its
  sender; the buyer's website view shows how each reply was sent; agency accounts connected by a
  removed member are flagged on the Integrations card (cleared on reconnect); a removed member
  sees "You no longer have access to <agency>"; an appointment whose Zoom link moved says "send
  the invitation again" (and a new invitation is allowed); the console refuses to start with
  NEXT_PUBLIC_UI_PREVIEW=1 in production. Two bugs fixed on the way: loadActor could pick a
  removed member's old suspended row over their new agency; offboarding blocked re-inviting
  after a Zoom link change.
- **Dev allowlist fix (ADR 0025 Q6) committed (6238739):** `EMAIL_DEV_ALLOWLIST` now gates
  every platform-composed email (`mail_message.kind` set: template email, appointment
  invitation) in the shared `deliverOutbound`. A person's own typed reply is not gated.
  **Your `.env.local` still has no `EMAIL_DEV_ALLOWLIST`** → invitations in dev are refused
  ("not on the development allowlist") until you add your test addresses.
- **CRM Phase 3b — real Google Calendar + Zoom (ADR 0020 "Phase 3b", migration
  0027) on `feat/crm`.** Real Google Calendar Connect verified end to end by the user
  on agents.lvh.me (2026-10-06) after the OAuth return-loop fix (commit 00c60a8).
  Zoom not yet tried with real credentials; TEST-PLAN T is the walk-through.
  Template email (ADR 0022, TEST-PLAN S) before it, also awaiting review.
  Not started (by instruction): Google Sheets, Google Reviews, Phase 6, Phase 7.
  Plan: `~/.claude/plans/pasted-content-id-f0ff-you-are-functional-frost.md`.
- Build order (locked): Agency UI → Agent UI → Consumer web
- Last tool: Claude Code
- Last updated: 2026-10-12
- Deploying: `apps/web` only, Vercel Hobby. `apps/console` waits for a real
  domain — see `docs/DEPLOY.md`. **Nothing is deployed yet.**

## Agent Assistant — Phases B and C, proposals you approve (2026-10-06, ADR 0025, migration 0029)

- `proposed_action` (frozen resolved args, card snapshot, idempotency key per model tool
  call, 48 h expiry, kept as audit). Permissions `proposed_action:read` (author, admin),
  `:decide` (author only), `:cancel` (author or admin).
- Write tools ONLY PROPOSE: `add_note`, `set_next_action` (B); `schedule_appointment`,
  `reschedule_appointment`, `cancel_appointment` (C). Handles only, can() at propose, card from
  the DB, at most 3 per answer. Bookings go on the person's own calendar: Google Calendar
  required (+ Zoom for a Zoom type) or "Connect … first" with no card. No invitation is ever
  sent; the card points to Calendar → Send invitation.
- Approve = one transaction: claim (proposed, unexpired, author's) → run through the screen's
  own core function (re-checks can()) → done or failed-with-reason; appointment sync after
  commit. Double click = one write. Reject, Cancel, cron expiry.
- Audit: activity `assistant_proposed/_approved/_rejected/_cancelled/_failed` (no text); a
  private note's proposal visible only to author + admins on the timeline.
- Panel: cards read back by id, Approve / Reject (Cancel for admins once delayed runs exist).
  Prompt `assistant@v3`.
- Tests: core 22 + ai 16 assistant unit tests, permissions, smoke "Console assistant" 10/10
  (matrix, double approve, access lost, calendar lost, expiry, private note, injection), and 21
  guards broken in a separate worktree, all seen red. Contacts 12/12, Appointments 3/3,
  Calendar/Zoom 5/5. Typecheck 10/10, lint 0 errors, test 747 + 286.
- Not done: card text editing before approve; no live model call yet (TEST-PLAN U/V are the first).

## Agent Assistant — Phase A, read-only (2026-10-06, ADR 0025, migration 0028)

- Tables `assistant_conversation` (author-only, handle map, one-turn claim, 30-turn cap) and
  `assistant_turn` (text, answer, SQL frames, exact API messages for append-only replay;
  failed turns shown, never replayed). `ai_run.agency_id`. RLS on, no grants.
- Permissions `assistant:use` (any active member) and `assistant_conversation:read` (author
  only, not admins).
- Core `@repo/core/assistant`: zod contract, handles (C/L/A/T/S; the model never sees an id),
  5 read tools each ONE statement through the screens' scope (`find_contacts`, `find_leads`
  — never offers, `find_appointments`, `list_templates` — approved, `check_connections`),
  caps ($1/person, $10/agency, inside AI_DAILY_BUDGET_USD; the skills' per-user cap no
  longer counts assistant spend), purge after 30 days (cron tick).
- AI `@repo/ai/assistant`: Sonnet 5.5 via ANTHROPIC_SKILL_AGENT_MODEL, streamed, adaptive
  thinking + `drop_block`, effort low, `fallbacks: "default"`, frozen prompt `assistant@v1`,
  date in a `<console_context>` user block, budget before every request, 8 tool calls/turn.
- Console: Assistant button + right panel on both surfaces, `/api/assistant` (NDJSON),
  History, "Using this contact". Label "Written by the assistant".
- Tests: core 16 + ai 14 unit (incl. red-team: invented tools, foreign/invented references,
  ids/names as references, a selected name closing the context tag, the 8-call cap, budget per
  request, no date in the prompt), permissions 2, smoke group "Console assistant" (6), one
  opt-in live red-team check in `pnpm smoke:ai`. 9 smoke + 11 unit guards broken in a separate
  worktree and seen red (two needed both of their layers broken).
- Numbers: typecheck 10/10, lint 0 errors, test 740 + 284, console production build OK
  (throwaway dist dir). Full `pnpm smoke` not run (user's dev data); groups run: Console
  assistant 6/6, Database 30/30, Appointments 3/3, Template email 5/5, Email conversations 7/7.
- Not done: no live model call has been made (TEST-PLAN U is the first); not clicked in a browser.

## Decisions from the client/PM (recorded 2026-10-05 — not built)

1. **Zoom:** each agent connects their own Zoom; an admin connects the agency Zoom.
   Letting other people's accounts connect needs the app approved/published on the Zoom
   Marketplace — check Zoom's docs in 3b. Tunnel for Zoom only if it refuses localhost.
   → ADR 0020 "Decided".
2. **Google:** ONE app (Calendar, Sheets, Reviews), permissions asked incrementally.
   Until verified, only test users can connect and tokens expire after ~7 days.
   Verification needs a domain, a homepage and a privacy policy. Least privilege:
   Sheets reaches only the picked file, never all of Drive. → ADR 0020 "Decided".
3. **Google Reviews, two steps:** first the Places API with the existing Google key
   (rating, count, a few recent reviews, Google attribution — check the Places terms on
   storing reviews); later the Business Profile API for all reviews. Business-level only;
   agent profiles show the agency's reviews; a review is linked to a contact only by an
   admin's manual "Link to contact", otherwise "Unmatched". Review requests by email with
   preview + approve; no incentives, no review gating. → ADR 0023 (planned).
4. **CSV listings import:** an owner/admin import goes live directly (option: import as
   draft); an agent import goes through submit-for-approval. Waiting for the sample CSV
   and the photo format. → ADR 0024 (planned).
5. **Domain and paid hosting come after testing.** Until then: nothing deployed, Google
   stays in Testing, no Zoom Marketplace publishing.
6. **Template-email skill** (ADR 0022): owner/admin-approved templates only; manual
   Prepare → Approve & Send, no scheduled sending; recipients frozen at Prepare, shown in
   full with skips and reasons, opt-out/consent re-checked at send; 48 h expiry.
7. Earlier, still standing: one person = one contact with role tags; agents see only
   what they could already open; phone matches are suggestions; enquiries are not
   marketing consent; read-only members view only and connect nothing.

## CRM Phase 3b — real Google Calendar and Zoom (2026-10-06, ADR 0020, migration 0027)

- Env: `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `ZOOM_OAUTH_CLIENT_ID/_SECRET`,
  `ZOOM_OAUTH_RETURN_BASE` (dev tunnel — Zoom refuses localhost for apps with a secret).
  Redirects: Google `http://localhost:3001/api/integrations/oauth/return`; Zoom
  `https://<tunnel>/api/integrations/oauth/return`. A provider with both values set is
  real; otherwise the stub (dev) — the stub stays for tests.
- Scopes: Google `calendar.events.owned` + `openid email`; Zoom
  `meeting:write:meeting meeting:update:meeting meeting:delete:meeting user:read:user`.
- OAuth: PKCE (no storage), renewal before expiry and on 401, Zoom's rotating refresh
  token stored by compare-and-swap, a dead refresh token → account `expired` →
  "Expired — reconnect". Disconnect revokes at the provider first.
- Appointments mirror OUT (sync.ts): acting as the assigned agent — their calendar;
  their Zoom else the agency's. Book/reschedule/complete/cancel → event created /
  moved / "✓ title" / deleted; Zoom meeting created / moved / deleted. No attendees,
  sendUpdates=none: Google emails nobody. One run at a time + our own event id: a
  double submit makes one event and one meeting. Only the Zoom join link is kept
  (never start_url or passwords).
- Read-back IN: the 5-minute cron `events.get`s our own upcoming events with their
  ETag; a move/deletion in Google is flagged ("Keep ours" / "Use Google's time"),
  never copied. Crashed syncs (`pending`) are resumed by the same tick.
- Console: card shows "Google Calendar · synced <time>", failures with Retry,
  conflicts, Join Zoom; Schedule panel says which Zoom hosts it or "Connect Zoom
  first" (Book waits unless a link is pasted; the server refuses too).
- Smoke: 5 checks with a fake Google/Zoom; `SMOKE_ONLY=<group>` runs one group.
- NOT verified against the real Google/Zoom yet (no credentials). Known limits in
  ADR 0020: an orphan Zoom meeting if the process dies mid-create; events stay in
  Google after a disconnect; Sheets + Calendar sharing one Google grant — check later.

## Template email to contacts (2026-10-05, ADR 0022, migration 0026)

- Tables `email_template` (draft → pending_approval → approved → retired),
  `contact_filter` (saved directory filters), `email_batch` (frozen template
  + filter snapshot, 48 h expiry), `email_batch_recipient` (frozen name/email,
  status queued|sending|sent|failed|skipped, skip reason, thread + message).
  RLS on, no grants. Applied on dev (additive only).
- Permissions: agents draft templates; only owner/admin approves/retires;
  a batch is seen by its author and admins; only its author sends; author or
  admin cancels; saved filters are personal.
- Flow: approved template + saved filter → Prepare (recipients frozen, every
  skip shown with its reason) → Approve & Send (guarded update — a second
  press sends nothing). No scheduled sending. Expired after 48 h.
- At send: consent, opt-out, archive, email change, 7-day repeat, daily caps
  and the dev allowlist re-checked per recipient. Limits from env (20/batch,
  50/agent/day, 200/agency/day, 7 days, 500 ms between messages). Each email
  is a conversation (thread + mail_message kind `template_email`), with the
  agency sender, a contact `/unsubscribe` link + List-Unsubscribe, and a
  timeline row. Retry re-delivers only failed recipients. Cron expires old
  batches, recovers stuck "sending" rows, resumes interrupted batches.
- `EMAIL_DEV_ALLOWLIST`: outside production only listed addresses/@domains
  are sent to (unset = nobody); production ignores it. `.env.example`,
  DEPLOY.md, smoke check.
- Skills library lists "Template email to contacts" → "Open bulk email";
  the runner refuses to schedule or run it (manual only).
- Console: /bulk-email (agency), /my-bulk-email (agent), template pages,
  batch page, "Save this filter" on the contact directory.
- Smoke: 5 checks (unapproved template, frozen list, opted-out at send,
  double approve/send, limits + allowlist, expiry + other agent's batch),
  each broken and seen red.
- **Your `.env.local` has no `EMAIL_DEV_ALLOWLIST`** → in dev every
  recipient is skipped until you add your own test addresses.

## CRM Phase 5 — skills (2026-10-05, ADR 0021, migration 0025)

- Before skills: the console REFUSES TO START in production with
  `INTEGRATIONS_STUB=1` or no/malformed `INTEGRATION_TOKEN_KEY`
  (instrumentation.ts; verified by starting a production build three ways).
  DEPLOY.md: own production key, losing it = everyone reconnects, rotation.
- Tables `skill` (library; agency_id null = built-in; handler fixed in code;
  Markdown body with front-matter `requires`/`model`/`schedule`),
  `agent_skill` (an agent's copy: own body, on/off, schedule + IANA zone,
  email-me), `skill_run` (status, summary + source, structured result, cost
  via ai_run.entity_id). Two built-ins seeded. Applied on dev.
- Permissions `skill:read|curate`, `agent_skill:read|manage` (own only; not
  even admins see another person's skills; read-only cannot add).
- Runner: claim (SKIP LOCKED + unique slot), nextRunFor, 3 failures pause;
  per run: member → requireIntegrations (library ∪ copy requires) → budget
  (skipped, no model call) → gather AS THE AGENT → model → citation check →
  store → optional email to the agent. In the existing cron tick.
- Citations (`skills/citations.ts`): every sentence cites a given record;
  numbers only when quoted verbatim from a cited record; else template.
- Models: `claude-sonnet-5-5` ($2/$10) and `claude-opus-5-5` ($4/$20) priced;
  tiers via ANTHROPIC_SKILL_{SUMMARY,AGENT,HARD}_MODEL (Haiku 4.5 / Sonnet 5.5
  / Opus 5.5). Both skills use the summary tier. The Claude API reference
  recommends server-side `fallbacks` for Sonnet/Opus 5.5 — add it when the
  agent tier is first used (not now: Haiku only).
- Console: /skills (+ library/new for admins), /my-skills, detail (editor,
  on/off with "Connect X first", schedule on the agent's clock, run now,
  history with cost), result page with clickable citations. Nav links.
- Vercel Pro cron: `*/5 * * * *` on /api/cron/alerts (DEPLOY.md).
- Numbers: typecheck 10/10, lint 0 errors, test 677 + 270, build 2/2, smoke
  149 passed / 1 failed (known dev account). Four skills smoke checks, each
  break-checked red.
- Not clicked in a browser: R. No live model call was made by any test.

## CRM Phase 4 — integrations hub (2026-10-05, ADR 0020, migration 0024)

- `integration_account` (applied on dev): provider, owner_type user|agency,
  owner_id, agency_id, label, granted scopes, status, last sync / error,
  AES-256-GCM token columns (key `INTEGRATION_TOKEN_KEY`, AAD = row + column,
  rotation via `_PREVIOUS`). RLS on, no grants. CHECKs: who may own which.
- Permissions `integration:read|manage|use`: own user-level; agency-level
  managed by owner/admin only, seen and used by members. Nobody reads anyone
  else's tokens; no screen read selects a token column.
- `requireIntegrations` (Zoom: own → agency; Calendar: own; Reviews: agency;
  Sheets: own → agency) + `ConnectFirst` card, wired into the contact
  Calendar tab and /calendar.
- OAuth plumbing: signed, user-bound, 10-minute state; one return route
  `/api/integrations/oauth/return` (public; on localhost it hops to the
  console host the state names); scope re-check → `permission_missing`.
  Dev stub provider (`INTEGRATIONS_STUB=1`, never in production).
- Pages: `/settings` (index), `/settings/integrations`, `/my-integrations`
  (agent nav). Disconnect deletes the row and its tokens.
- `.env.local` on this machine now has a generated `INTEGRATION_TOKEN_KEY`,
  `INTEGRATION_OAUTH_RETURN_BASE=http://localhost:3001`, `INTEGRATIONS_STUB=1`.
- Numbers: typecheck 10/10, lint 0 errors, test 660 + 263, build 2/2, smoke 145
  passed / 1 failed (known dev account). Four new smoke checks, each
  break-checked red (the user-binding one only after it was tightened).
- NOT SURE (ADR 0020): one Google app or three; Zoom's http/localhost redirect
  rules; exact scope names (verify in 3b).

## CRM Phase 3a — appointments (2026-10-05, ADR 0019, migration 0023)

- `appointment` table (applied on dev): contact, optional related property,
  assigned agent, type, status, UTC instants + booking zone, location / link,
  internal notes, outcome, attendees (JSON), reminder choice (stored only),
  empty external_calendar_* / zoom_meeting_id for 3b. `mail_message.kind`.
- Permissions `appointment:read|read_all|create|update|assign`: admin all;
  others own (assigned or booked by them); read-only views only. SQL twin
  `appointmentScopeFilters`.
- Complete / cancel / reschedule with outcome; each change an `activity` row.
- Invitation email: opt-in, exact preview, explicit Send, via the conversation
  pipeline (a new conversation with the contact), transactional, never the
  internal notes. Counts toward `EMAIL_LIMIT_PER_AGENT_DAY` (50) /
  `EMAIL_LIMIT_PER_AGENCY_DAY` (200), which count `mail_message.kind` rows only.
- Times: `@repo/core/time` converts typed wall-clock ⇄ instants in a NAMED zone
  (the browser's); the UTC-pinned test fails on the naive `new Date(typed)`.
- Console: contact Calendar tab (Upcoming/Past, Schedule side panel, Google +
  Zoom "Not connected"), `/calendar` (agency, agent filter), `/my-calendar`
  (agent; replaces the dead "Inspections" link). Day-grouped list, no library.
- Merging contacts now moves appointments too.
- Numbers: typecheck 10/10, lint 0 errors, test 645 + 263, build 2/2, smoke 141
  passed / 1 failed (known dev account). One earlier smoke run had 12 HTTP
  failures from the web dev server recompiling after `pnpm build`; a re-run was
  clean. Three new smoke checks, each break-checked red.
- Not clicked in a browser: TEST-PLAN P.

## CRM Phase 2 follow-up (2026-10-05, migration 0022)

- `note.is_private` (applied on dev). Private notes: admins + author only, on
  the Notes tab, timeline and counts (`noteVisibleSql`). Ask the client if
  that is enough.
- Link a contact to a brand-new address with the listing form's address
  picker (`linkContactNewAddress`); existing properties are never changed
  (`upsertProperty` `leaveExisting`). TEST-PLAN O14–O15.
- Numbers: typecheck 10/10, lint 0 errors, test 625 + 263, build 2/2, smoke
  138 passed / 1 failed (known unmirrored dev account). Two new smoke checks,
  each break-checked red.

## CRM Phase 2 — Contact 360 (2026-10-05, ADR 0018 addendum)

- Migration 0021 applied on dev (additive): `contact.archived_at/_by`,
  `note.deleted_at/_by`.
- Profile tabs: Overview (facts, next-action quick edit, counts, recent
  activity, duplicates + Merge), Timeline (one UNION query, cursor paging),
  Properties (ties + enquired addresses → /property/[id]; link/unlink known
  addresses), Emails (inbox ThreadList/ThreadReader reused), Enquiries
  (LeadTable `compact`), Notes (add/edit/soft-delete), Calendar and Reviews
  ("Not connected").
- Every tab and count uses the inbox's own scope (`leadScopeFilters`,
  `threadScopeFilters`, factored out of list-leads/threads).
- Archive/restore + "Archived" directory filter. Contact-assigned email
  (`notifyContactAssigned`), not on self-assignment.
- The backfill was NOT applied when the user reported it; applied 2026-10-05
  by Claude Code (4 leads → 4 contacts). Section N must be re-tested.
- Numbers: typecheck 10/10, lint 0 errors, test 624 + 263, build 2/2, smoke
  136 passed / 1 failed (known unmirrored dev account). Five new smoke checks,
  each break-checked red.
- Not clicked in a browser: TEST-PLAN sections N and O.

## CRM Phase 1 — contacts (2026-10-05, ADR 0018)

- **Migration 0020 applied on dev** (additive): `contact`, `contact_role`,
  `contact_property`, `note`, `activity`; `lead.contact_id`,
  `mail_thread.contact_id`; `au_phone_key` (generated `phone_key`);
  `contact_upsert` + BEFORE INSERT triggers on `lead` and lead-less
  `mail_thread`. Same email = same person (fills blanks, never overwrites);
  same phone = duplicate SUGGESTION only. `event` left untouched.
- **Backfill applied 2026-10-05** (see Phase 2). Was:
  `pnpm --filter @repo/core contacts:backfill` (dry run: 4 leads → 4 contacts
  on dev) then `... --apply`. Smoke "every lead and conversation has its
  contact" is red until then.
- Permissions: `contact:read|read_all|create|update|assign|merge`,
  `note:create|manage`. Visibility = can() + `contacts/visibility.ts`, held
  together by a smoke parity check. Agents edit only contacts assigned to them;
  read-only views only. Agency-address mail from a contact is now readable by
  whoever sees the contact and answerable by its assignee.
- Consent: `marketing_consent_at/_by/_note`, `email_opt_out_at`. An enquiry is
  not consent.
- Console: `/customers` (+ `/new`, `/[id]`) and `/my-contacts` (agent nav
  "Contacts"). Profile is the Phase 1 card; Contact 360 tabs are Phase 2.
- Not clicked in a browser: TEST-PLAN section N.
- Numbers: typecheck 10/10, lint 0 errors, test 619 + 263, build 2/2,
  smoke 130 passed / 2 failed (backfill not applied; known unmirrored dev
  account). New checks break-checked red: SQL/can() parity, trigger
  never-overwrites, agency mail reaching the contact's agent.
- 0019 applied on dev 2026-10-05; the live Data API refuses the anon key on
  every table (curl-verified). No browser code uses `.from()`/`.rpc()` — the
  user may switch the Data API off.

## CRM Phase 0 (2026-10-05)

- M6 committed on `main` (3 commits); CRM work on `feat/crm`.
- **Migration 0019 — applied on dev after review** (ADR 0017, "the server is the only
  door"): `anon`/`authenticated` held ALL privileges on every public table,
  4 tables had no RLS, and policies let any member update any listing and read
  every offer/email through the Data API. 0019 revokes the grants (and the
  default ones), turns RLS on everywhere, drops the wide policies. Dry-run in a
  rolled-back tx: 0 grants left, `authenticated` refused. Smoke check "the
  public schema is closed to the browser keys" is RED until 0019 is applied —
  apply with `pnpm --filter @repo/db db:migrate` once approved.
- `/overview` carries a "Demo data" banner; the fake AI briefing is labelled a
  sample. `.env.example`/env.ts/DEPLOY/CLAUDE.md: media is Supabase Storage;
  the model default lives only in `packages/ai/src/models.ts`;
  `ANTHROPIC_ALERT_MODEL` declared.
- Email: sending is from verified `quotemydecking.com.au`; receiving on the
  `*.resend.app` address. A real round trip (console reply → Gmail → back into
  the thread) worked on 2026-10-03. M5, M7–M13 still to click through.
- Smoke 125 passed / 2 failed: the 0019 check (expected) and "every account is
  mirrored" (dev account that has not opened a page since the fix).

## What M6 added (ADR 0016)

**The platform owns the conversation; Gmail is a window onto it.** No OAuth
into anybody's mailbox. Every email a conversation sends carries a signed
Reply-To, `t+<threadId>.<hmac>@MAIL_INBOUND_DOMAIN`; Resend Inbound posts the
answer to `/api/mail/inbound` (Svix-signed) and it lands in the same thread.
Each agency also has `<slug>@MAIL_INBOUND_DOMAIN`, an admin-only mailbox.

- **Data:** `mail_thread` (one per lead, made by a trigger on `lead` insert,
  backfilled), `mail_message`, `mail_read` (per-person unread). Status and
  assignee stay on `lead`. RLS on, SELECT-only. `user.verified_email` (0017).
- **Permissions:** `mail:read` = `lead:read`, `mail:send` = `lead:update`, an
  offer's thread also needs `lead:read_offer`, agency-address mail is
  `lead:read_all` only. Non-admins narrowed in SQL, as the lead inbox.
- **Sending:** recorded `queued` in a tx, sent after it, marked `sent`/`failed`
  with a retry. An agent answering a notice from Gmail is RELAYED to the buyer
  only when DMARC passed and can() lets them send; otherwise held with a reason.
- **Console:** `/inbox` (agency) and `/my-inbox` (agent) — folders, unread,
  reader with status/assignee pickers, composer, sandboxed original HTML (no
  remote fetches). Nav badges. "Open conversation" on every lead row.
- **Website:** `/account/messages` (+ `/[id]`). Email-matched threads show only
  after the account proves its address via an emailed link (`/verify`, POST to
  confirm) — sign-up here does not confirm emails, so the address alone would
  let anyone read someone else's agency mail. Alert emails stay on `/alerts`.
- **Off until configured:** with `MAIL_INBOUND_DOMAIN` + `MAIL_REPLY_SECRET`
  unset, console replies still send and replies go to the agent's own email.
  Setup steps: `docs/DEPLOY.md` → "Email conversations — one-time setup".

## What M5 added

Four pieces, built in order, each verified before the next started.

**A sale can be recorded at all.** `listing_status` already had `'sold'` and
`sold_price` / `sold_date` already existed, but `setListingStatus` narrowed its
transition union to exclude `'sold'` and no zod schema mentioned the columns —
so only the seed had ever written a sale. `setListingStatus` now accepts it,
carrying `soldDetailsSchema`, under a new `listing:sell` permission. The console
has a "Mark sold" dialog and an "Under offer" control, neither of which existed.

**History follows the property, on every page (ADR 0013, amending 0012).**
The client reversed "hide history while on the market": `/listing/[id]` now
renders the Timeline and a Property history tab whenever the address has an
earlier entry. `upsertProperty` matches on `addressKey` (case, spacing,
St/Street-style abbreviations, unit prefixes, "32/6E" in the number box) under
a transaction-scoped advisory lock, so a second agency re-listing an address
joins the existing property. A live address sends `/property/<id>`, an old
`/listing/<sold id>` bookmark and `/sold` cards to the live listing ("For sale
now"); off-market, the bookmark goes to `/property/<id>`. Drafts never redirect.
Joining an existing property writes only the physical facts the new ad states
(`providedPhysicalFields`); blanks clear a field only when an agent edits the
property their own listing already stands on.

**`/property/[id]`** — the first public route keyed by a property. Renders only
when nothing at the address is on the market AND something there was once
public; `noindex`; reachable by direct link only. Carries the sale history in
the portal-standard vertical timeline (year · Sold · price · "Sold <date> by
<agency>" · thumbnail).

**A private offer** goes to the agency that last sold the address, as a `lead`
row and an email. `lead` is now anchored to `property_id` (NOT NULL) with a
nullable `listing_id`. Sign-in required — the first code to populate
`lead.user_id`.

**The guide can see sales.** New `recent_sales` tool + prompt v9. Asked "what
has sold in Pakenham within 30km", a live model now calls it and answers with
the exact price, date and distance, and says the sale is not something to buy.

**Approval and agent lead privacy (ADR 0014, 2026-10-02).** Agents no longer
publish: `listing:publish` is owner/admin only, and the new `listing:submit`
(admin or named agent) moves a draft/withdrawn listing to `pending` ("Pending
approval"). The agency table offers "Approve & publish" / "Send back"; the agent
table "Submit for approval" / "Cancel submission"; both headers count
"Awaiting approval". Leads: `lead:read_all` (admins) is the whole agency;
anybody else's inbox is narrowed in SQL to leads assigned to them or from a
listing they are named on (unassigned included), and such an agent may work an
unassigned one. The agent desk's Leads link is live at `/my-leads`. Known gap:
an agent editing a LIVE listing still changes the public ad without review.

**Lead triage (2026-10-02).** `/leads` now moves leads: a status picker
(new / contacted / qualified / closed, any direction) and an assignee picker.
`lead:update` — an admin, or the member the lead is assigned to (resource
`ownerId`); `lead:assign` — admins. On an offer both also need
`lead:read_offer`, and an offer cannot be assigned to someone who cannot read
it. `updateLeadStatus` guards on the assignment it decided on (a reassignment
in between is a `conflict`); `assignLead` repeats the active-membership check
inside the UPDATE. Another agency's lead id is `not_found`.

**The lead inbox.** `/leads` was an `AgencyPlaceholder`; it now reads the `lead`
table. Enquiries and private offers share one screen with tabs, because they
share a row and every lead is anchored to a property — but offers are rare and
high-value and would be buried in a date-sorted list, so the tabs plus a nav
badge are what stop the feature failing quietly. Two permissions, not one:
`lead:read` opens the inbox for any active member; `lead:read_offer` is
owner/admin only and becomes a WHERE clause, so a non-admin sees an inbox in
which offers never existed rather than one saying three are hidden.

## Decisions worth not relitigating

- `listing_status` is the single lifecycle authority; `channel` stays what the
  ad sells. The `'sold'`/`'leased'` channel values are legacy — docs/adr/0012.
- An offer hangs off the property, never the historic sold listing:
  `lead.listing_id` is `ON DELETE CASCADE` and `setListingStatus` accepts
  `'withdrawn'` from any status, so an agency could withdraw a sold listing,
  clear `UNDELETABLE`, delete it, and silently cascade away every offer.
- `EmailMessage` is now `marketing | transactional`. Transactional carries no
  one-click unsubscribe, because that header promises an unauthenticated POST
  endpoint and inventing one would ship a way to silently switch an agency's
  offer notifications off.
- Sold data is NOT in the public search surface. `PUBLIC_STATUS` stays `'live'`
  at all 8 filter sites, so the alerts scheduler and email digests are
  unchanged. The guide reaches sold data through its own tool.

## Numbers as of this entry (2026-10-06, Phase 3b)

- `pnpm typecheck` and `pnpm lint` clean; `pnpm build` 2/2.
- `pnpm test` 709 (@repo/core) + 270 (@repo/ai), all offline and free.
- `pnpm smoke` 159 passed, 1 failed, 14 skipped. The failure is the known dev
  auth account with no public.user row (not this work). The 5 new Google/Zoom
  checks pass, each break-checked red in a separate worktree.
- A run started while the dev server was recompiling skips the web HTTP checks
  ("web app is not running"); re-run once it answers.

## Open / next

- **To make replies come back:** set `MAIL_INBOUND_DOMAIN` to Resend's
  `<id>.resend.app` receiving domain (Emails → Receiving → ⋯) and
  `MAIL_REPLY_SECRET`; restart. Pulling works on localhost — no webhook needed.

- **One browser = one account across web, agency and agents** (shared
  `.lvh.me` cookie, ADR 0003). Signing in on the website as a buyer signs the
  console out of the agency account, and the reverse. Test the buyer side in a
  private window or another browser.

- **To switch inbound on:** Resend receiving subdomain + MX, webhook to
  `/api/mail/inbound` (`email.received`), then `MAIL_INBOUND_DOMAIN`,
  `MAIL_REPLY_SECRET`, `RESEND_WEBHOOK_SECRET`. Then TEST-PLAN M1–M13.
- **Not built (ADR 0016 "Not done"):** attachments are listed, not stored or
  sent; no rich-text composer or signature; buyers reply by email, not on the
  site; no realtime — the inbox refreshes on navigation and after actions.
- **Private-offer notice** (web `offer-action.ts`) does not carry the thread's
  Reply-To yet; offers are answered from `/inbox`.
- **Dev data:** property `e99d1a30` (32/6E Henry Street) still has the
  overwritten land/pin/address from the 2026-10-02 relist test.
- **Dev DB pool:** `.env.local` DATABASE_URL is the transaction pooler (:6543);
  DIRECT_URL the session pooler for migrations.
- **Next on leads/listings:** an open/closed filter; telling admins a listing
  is waiting; review of edits to live listings (ADR 0014 "Not done").
- `apps/web` and `apps/console` were written by Claude Code at the user's
  explicit request, against the tool split in CLAUDE.md.
