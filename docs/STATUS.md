# Status — 2026-11-04 (Claude Code, Mac)

Short on purpose: where things stand now. History up to 2026-10-31 is in `docs/archive/STATUS-to-2026-10-31.md`;
how to work on either laptop is `docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
Version 1 is built except what waits on the client and on Twilio. `main` = `d3eb906`, deployed. Branches, not merged:
`chore/tech-debt` (pushed), **`feat/sms-part2`** (committed, NOT pushed: ADR 0074 part 2), **`feat/customer-profile`**
(committed, NOT pushed: ADR 0079) and **`feat/consumer-skills`** (on top of it; `573f0e7` committed, NOT pushed: ADR
0080 — consumer skills + C0 foundation; C1 Affordability AI built, uncommitted). Merge in that order.

## Database
89 migrations recorded (0000–0088); **0088 (C8: `once`/`done`, task columns, `buyer_automation`, `automation_event`, `guide_message`, RLS on) applied 2026-11-04** (the user's go). **0087 (`discovery_hidden`, RLS on) applied 2026-11-04** (the user's go). **0086 (`inspection_note`, `inspection_photo`, RLS on) applied 2026-11-04** (the user's go). Private bucket `inspection-photos` made 2026-11-04 (4 MB, JPEG/PNG, no policies). `suburb_census` holds 15,345 suburbs (ABS 2021). **0080 (`contact.address_*`), 0081 (`consumer_skill_switch`) and 0082
(`listing_price_change` + its trigger) applied 2026-11-03** (the user's go; checked after: 82 recorded, 6 address columns, the table exists). Dev database =
production database.

## Checks
- Unit: core 1772, ai 406 — all pass, offline. Smoke "Consumer skills (ADR 0080)" 22/22, 0 skipped, 2026-11-04. Live AI group "Consumer skills, live AI (ADR 0080)" 15/15, three runs in a row, with C8's four checks, 2026-11-04 (the user's go). Typecheck 10/10. Web lint 0 errors. /affordability and a listing's
  "Costs to buy" panel rendered on the local dev server (figures match the mock and the unit tests).
- Smoke 2026-11-03, live DB: "Consumer skills (ADR 0080)", "Customer profile (ADR 0079)", "Imports: contacts and
  Google Sheets" — 5/5 green (the import check sorted roles by enum order, not text: test fixed, data was right).
  The consumer cron gate broken on purpose → red with its message, then restored.
- CI: green on `chore/tech-debt` (`48ab812`). A full smoke run (the green baseline) still NOT done since tech debt.

## Done this period
- 2026-11-03: ADR 0080 — consumer skills. `docs/CONSUMER-SKILLS.md` plans all 21 of the client's consumer AI skills
  (C0–C9; the user: answers ON / acts OFF, own + free data first, Affordability → Due-Diligence → Renovation first).
  C0 built: catalog, `consumer_skill_switch`, `/account/skills`, chat tools + Buyer AI + Smart Alerts gated,
  `CONSUMER_SKILLS_PAUSED`. C1 Affordability AI built (mock's six decisions as recommended): stamp duty for 8 states
  with sources, repayments, borrowing at rate + 3%, `/affordability`, a listing's "Costs to buy" panel, the guide's
  `affordability_estimate` (prompt v11). TEST-PLAN CG.
- 2026-11-02: ADR 0079 — the customer profile. Add customer asks for name, email, phone and address (the listing
  form's picker; no server geocoding); the same email adds to that profile (blanks filled, nothing overwritten, other
  values on the timeline as "Different details given"; linked only for someone who may see it); the import takes
  Street address / Suburb / State / Postcode and fills existing people (`updated`) instead of skipping them; "missing"
  chips on the list and the profile; search by suburb; a merge carries the address. TEST-PLAN CF.
- 2026-11-02: ADR 0074 part 2 on the user's answers to the five SMS rules — Bulk SMS (`/bulk-sms`, `/my-bulk-sms`),
  "Text selected" on Matching buyers, the workflow step "Send SMS" (pair skill Workflow texts), the pair skill Bulk SMS,
  the agency number, 9 am–8 pm, 3 automatic texts a caller (missed call + workflow), 100 texts a number, and
  `SMS_DEV_ALLOWLIST` for dev with a real key. Consent stays the Bulk email rule (the user asked for "everyone"; the
  Spam Act needs consent — explained).
- 2026-11-02: the Retell agent made (`agent_93b24a5de57c293fe91e59d943`, webhook on `realestate-ai-users.vercel.app`).
- Before: 3.4 part 1 (ADR 0074) · ADR 0075 · Outlook (ADR 0076) · AI understands (ADR 0078).

## Blocked on the client
- Twilio test account (KYC) — promised tonight; then numbers, and TEST-PLAN BX/BY/BZ/CE with real Twilio + Retell.
- The client's approval of the SMS rules (built on the user's answers), Control Centre (4) → 4.6/4.7, 4.4 triggers (5).
- The Microsoft Entra app (Outlook), the temporary domain (then `retell:setup` again and `phone:repoint`).

## Waiting on the user
- TEST-PLAN CF in a browser (0080 is applied and its smoke is green).
- Push `feat/sms-part2`; merge `chore/tech-debt`, then `feat/sms-part2`.
- Vercel → web + both console projects: `RETELL_API_KEY`, `RETELL_AGENT_ID`, `EMBEDDINGS_PROVIDER=voyage`,
  `VOYAGE_API_KEY`, then redeploy — the user said 2026-11-02 they are doing it; not checked here.
- The Voyage backfill (`pnpm --filter @repo/ai search:backfill`) — paid, on the live database; on hold (the user).
- Local-only branches `feat/crm-visibility` and `feat/crm-assistant-more`: keep or delete.

## Next
0. C1 (`dcdce7c`) and C2 Due-Diligence AI committed; C2's live-model group green (the user's go). TEST-PLAN CG, CH
   in a browser. C3 Renovation AI approved (product team); step 1 built, uncommitted: core types, the 25 kinds
   of work, plan/photo contracts, quotes in cents (`5bd7be8`); permit rules VIC/NSW/QLD (`e8b683e`); end to end
   built, uncommitted: planner + room reader, two routes, /renovation, the listing link, `renovation_plan` (v13).
   Live-model group 12/12 green; committed `ae5d96a`; pushed (`origin/feat/consumer-skills`). Permit rules for all
   eight states (WA, SA, TAS, ACT, NT added; council-only triggers still unverified). C4 mock approved (`67747b5`); shortlist committed (`a599f7d`); Property Monitor committed (`e42736a`); Personal
   Property AI committed (`b3f5082`); Smart Alerts upgrade committed (`bdf87a5`) — C4 complete.
   C5 Research committed in two (census `79fdbd3`, features) and pushed; its live-model checks green (the user's go;
   prompt v14 tightened twice on what they found). C6 Inspections: mock `docs/mocks/consumer-inspections.html`
   (nine decisions) approved 2026-11-04; C6 built in the user's autonomous loop; 0086 applied, bucket made, smoke and
   live checks green; committed and pushed 2026-11-04. TEST-PLAN CK1–CK9, CL1–CL13: the user, in a browser.
   C7 Discovery & Opportunity: mock `docs/mocks/consumer-discovery.html` (ten decisions) approved 2026-11-04 (`e246290`);
   built in the user's autonomous loop, migration 0087 applied, committed and pushed. Real data today: Opportunities
   in Pakenham shows 3 long campaigns (site median 43 days); price changes and medians say why they are empty; no
   home not for sale qualifies yet (every sale is Oct 2026). TEST-PLAN CM1–CM13: the user, in a browser.
   C8 Acting for the buyer: mock `docs/mocks/consumer-acting.html` (twelve decisions) approved 2026-11-04 (`b981657`);
   built in the user's autonomous loop, migration 0088 applied, committed and pushed. TEST-PLAN CN1–CN16: the user, in a
   browser. 18 of the 21 skills built; C9 (Visual Search, Immersive, Property Development) is next and needs outside
   providers chosen first (image embeddings, a media pipeline, planning data). C9 mock
   `docs/mocks/consumer-media-land.html` (twelve decisions + the providers compared) approved 2026-11-04 (all twelve, providers
   as recommended); building in order Immersive → Development → Visual Search. Immersive BUILT and committed: unit
   core 1781 / ai 414, typecheck 10/10, both builds, smoke "Consumer skills" 23/23, its two live checks green (the
   user's consent). Development BUILT and committed: migration 0089 applied
   (`planning_zone`, the user's go; 90 recorded) and SA's zones loaded (5,402 polygons, 65 zones, data dated
   2026-08-21, 20 MB; reload: `pnpm --filter @repo/db db:zones`, fortnightly at most); VIC/NSW asked live. Unit
   core 1795 / ai 418, typecheck 10/10, lint 0 errors, web build, smoke "Consumer skills" 25/25, its live check green
   (the user's go). Visual Search next: 1 photo in the database (on a sold listing), 0 on public listings. Real data: 1 photo in the database; REAXML import reads no floorplans, video or tour links yet.
   TEST-PLAN CG/CH/CI: the user, in a browser. Re-check duty rates
   every 1 July (dates in `duty-rates.ts`); NT, ACT general and SA new-home relief still "not verified".
1. Push and merge `chore/tech-debt` → `feat/sms-part2` → `feat/customer-profile` → `feat/consumer-skills` (the user's go).
2. Twilio tonight → connect on the phone test agency → BX, BY, BZ, CE.
3. When the client answers: 4.6/4.7, then 4.4.
4. Last: the user's browser walk (TEST-PLAN BN–BZ, CA–CE), then go-live (`docs/DEPLOY.md`, `docs/DNS-CUTOVER.md`).

## Watch
- Stamp duty: re-check every 1 July; NT, ACT general, SA new homes, QLD first home land unverified (ROADMAP technical
  debt; `pnpm smoke` notes both on every run).
- ADR 0079: the assistant's create/update contact cards do not take an address yet; imported addresses are not
  geocoded (no pin); every enquiry-made contact shows "Address missing" — by design (the user's answer 3).
- "Text selected" ticks only buyers the email rule allows (ADR 0060 decision 4): a buyer with a mobile and no email
  cannot be texted from that tab yet — Bulk SMS with a filter reaches them.
- Planted words in an enquiry pass the AI fact check (ADR 0078 known limit); the approval card is the guard.
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
