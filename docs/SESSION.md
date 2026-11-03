# Session log (newest on top)

Entries before 2026-10-31 (late) are in `docs/archive/SESSION-to-2026-10-31.md`. Keep this file short: when it
passes ~10 entries, move the older ones to a new archive file.

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
- Left unfinished (exact next step): C3 Renovation AI mock — the user's decisions; TEST-PLAN CG/CH in a browser.
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
