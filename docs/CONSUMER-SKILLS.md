# Consumer AI Skills — the plan

The client's list of 21 skills for the public site (site.com.au), where each one stands and the order they
are built in. Started 2026-11-03 (ADR 0080). Assessed from the code on `feat/consumer-skills`: about **16%**
of the list existed before this plan, nearly all of it inside the property chat. **Percentages are estimates
from reading the code, not measured.** Update this file as each phase lands.

## The rules every skill follows

1. **One catalog, one switch each** (`packages/core/src/consumer-skills/catalog.ts`, ADR 0080). A signed-in
   buyer turns any skill on or off at `/account/skills`. A visitor who is not signed in gets the defaults.
2. **Defaults (the user, 2026-11-03):** a skill that only *answers* is ON; a skill that *acts by itself* or
   *contacts somebody* (an agent, an email that is not an answer) is OFF until the buyer switches it on.
3. **The platform can pause any skill for everyone** (`CONSUMER_SKILLS_PAUSED`, a comma list): cost or a
   legal question, without a deploy. The page says "Paused by the platform".
4. **Off means off where it runs**, checked in core: a chat tool answers "switched off in your Skills"
   (the tool list stays frozen, so the prompt cache is unchanged), a page shows the switch instead of the
   feature, a background job skips the person.
5. **The model never produces a number** (#4). Repayments, stamp duty, costs, medians and distances are
   computed in `packages/core` and handed to the model as tool results. Every rate table in code carries
   its source and the date it was checked.
6. **Data (the user, 2026-11-03): our own records plus free public data first.** Our sold and listed
   records, ABS census, state revenue-office duty rules, state planning-portal links. When there is not
   enough data the skill says so; it never fills the gap. A paid provider (CoreLogic, PropTrack, Domain)
   can be added behind the same functions later.
7. **General information, never advice.** Money skills say they are estimates and not credit assistance
   (NCCP); due-diligence skills say they are not legal advice and point to a conveyancer.
8. **Mock first** for each skill with a page (`docs/mocks/consumer-*.html`); the user approves, then code.

## The 21 skills

`answers` = default ON · `acts` = default OFF · 🔒 = needs a signed-in account

| # | Skill (key) | Kind | Phase | Before | What v1 does |
|---|---|---|---|---|---|
| 1 | AI Property Search (`property_search`) | answers | live | 65% | The chat's search, cheapest-near, get-listing tools |
| 2 | Personal Property AI (`personal_profile`) 🔒 | acts | C4 | 10% | A preference profile learnt from searches and saves; seen, edited, deleted by the buyer |
| 3 | Discovery AI (`discovery`) | answers | C7 | 20% | "You may like" from the profile, including off-market property pages |
| 4 | Smart Alerts (`smart_alerts`) 🔒 | answers¹ | live → C4 | 60% | Saved-search alerts (built); C4 adds market-change alerts |
| 5 | Tasks (`tasks`) 🔒 | acts | C8 | 25% | One-off or repeating research ("every Monday, new 3-bed in Pakenham + what sold") with a report |
| 6 | Automation (`automation`) 🔒 | acts | C8 | 10% | When X happens (price drop, new listing, inspection added), do Y (tell me, add to shortlist) |
| 7 | Property Analyst (`property_analyst`) | answers | C5 | 30% | One property explained from public records, every point cited (reuses ADR 0065) |
| 8 | Suburb AI (`suburb_insights`) | answers | live → C5 | 15% | Recent sales (built); C5: a suburb page from our records + ABS, suburb vs suburb |
| 9 | Comparison AI (`comparison`) | answers | C5 | 0% | 2–4 properties side by side (numbers from SQL), the model explains the trade-offs |
| 10 | Inspection AI (`inspection_planner`) | answers | C6 | 15% | Plan a Saturday: pick listings, order the open homes by time and distance, add to calendar |
| 11 | Inspection Assistant (`inspection_notes`) 🔒 | answers | C6 | 0% | Notes, photos and a checklist per inspection, private to the buyer, summarised |
| 12 | Visual Search AI (`visual_search`) | answers | C9 | 0% | "Homes that look like this" from a photo or a style (image embeddings) |
| 13 | Immersive Property AI (`immersive`) | answers | C9 | 10% | Floorplans, video and tours stored and shown; ask the guide about a room |
| 14 | Agent AI (`agent_messages`) 🔒 | acts | C8 | 45% | The guide drafts an enquiry or question to the agent; the buyer reads it and sends it |
| 15 | Buyer AI (`buyer_assistant`) | answers | grows | 10% | The property chat itself; each skill adds its tool here, behind its own switch |
| 16 | Property Monitor (`property_monitor`) 🔒 | acts | C4 | 20% | Watch an address: listed, price change, under offer, sold — including Not for Sale → For Sale |
| 17 | Opportunity AI (`opportunities`) | answers | C7 | 0% | Price drops, long days on market, under the suburb median — from SQL, explained |
| 18 | Property Development AI (`development`) | answers | C9 | 0% | Land size, zoning links, subdivision questions to ask; needs planning data (later) |
| 19 | **Affordability AI** (`affordability`) | answers | **C1** | 0% | Repayments, stamp duty + first-home concessions per state, borrowing estimate, scenarios |
| 20 | **Due-Diligence AI** (`due_diligence`) | answers | **C2** | 5% | Per property: the state checklist, what our records show, questions to ask, official overlay links |
| 21 | **Renovation AI** (`renovation`) | answers | **C3** | 0% | A scope from photos or words (model), priced from a dated cost table (code), permit pointers |

¹ Smart Alerts sends email, but every alert is already a request the buyer made one at a time, and
existing alerts must keep running — so it is ON (the same reasoning as ADR 0069 §3).

## Phases

- **C0 — Foundation** (ADR 0080, migration 0081). Catalog, `consumer_skill_switch`, the gate, `can()`
  actions, the chat tools behind their switches, `/account/skills`, the platform pause, tests + smoke.
- **C1 — Affordability AI.** Mock → `packages/core/src/affordability/` (repayment maths, duty tables per
  state with concessions, serviceability with the APRA 3% buffer, scenarios) → a page `/affordability`
  → a chat tool `affordability_estimate` → "show homes I can afford" opens a search.
- **C2 — Due-Diligence AI.** Mock → per-state checklists in code (sourced) → what our records say about the
  property (sale history, days on market, price changes, relists) → questions to ask the agent → overlay
  links (flood, heritage, zoning) → a section on the listing and property pages + a chat tool.
- **C3 — Renovation AI.** Mock → a cost table (ranges per item and per m², dated, sourced) → the model turns
  photos or words into a scope (items only, no prices) → core prices it → permit pointers per state.
- **C4 — Profile & watch.** Personal Property AI (opt-in profile), the shortlist UI (the table exists),
  Property Monitor, Smart Alerts market changes.
- **C5 — Research.** Property Analyst, Suburb AI pages, Comparison AI.
- **C6 — Inspections.** Inspection planner (+ .ics), Inspection Assistant (private storage bucket).
- **C7 — Discovery & Opportunity.**
- **C8 — Acting for the buyer.** Agent AI (draft → buyer sends), Tasks, Automation (reuses the schedule runner).
- **C9 — Media & land.** Visual Search (embeddings provider), Immersive (media pipeline for floorplans and
  video — touches the console), Property Development AI (planning data source to be chosen).

## Status

- [x] C0 Foundation — committed on `feat/consumer-skills`. Migration 0081 applied 2026-11-03 (with 0080); smoke
  "Consumer skills (ADR 0080)" green, broken on purpose (the cron gate) and seen red. Unit: core 1587, ai 340.
- [x] C1 Affordability — mock's six decisions taken as recommended (the user: "next start", 2026-11-03). Core:
  `packages/core/src/affordability/` (duty for 8 states with sources; repayments, +1%/+2%, borrowing at rate + 3%
  APRA buffer, dearest home after duty and costs; the page address). `/affordability` (GET form, state in the URL,
  Skills gate; in the middleware matcher for the session), "Costs to buy this home" on listings (duty only — no
  rate we could source; hidden by a `skills_off` cookie mirror when the buyer switched it off), the guide's
  `affordability_estimate` (prompt v11). Not built from the mock: rejecting a reply whose figure is not in a tool
  result — the guard is the prompt rule and the tool card, as for search figures. TEST-PLAN CG.
- [x] C2 Due-Diligence — mock's seven decisions as recommended. Migration 0082 (price changes by trigger, applied
  2026-11-03); `packages/core/src/due-diligence/` (records from SQL with references; checklists for VIC, NSW,
  QLD, WA from their official pages, the general list for SA, TAS, ACT, NT; map links VIC, NSW; the AI's lines
  checked for references and figures); "Before you buy" on listings and /property with ticks in the browser; the
  AI summary + questions on a button (`/api/due-diligence`, summary tier, rate-limited, an hour's cache, the
  buyer puts the questions into the enquiry form and sends them); the guide's `due_diligence` (prompt v12).
  Live model checked 2026-11-03 (`SMOKE_ONLY="Consumer skills, live AI (ADR 0080)" pnpm smoke:ai`, the user's
  go): it found the model writing "[K2]" into its questions, which the figure check read as "2" and dropped 5 of 6 —
  fixed in core (`cleanLine`) and the prompt (v2); then summary 2/2, questions 6/6, and the guide's affordability
  and due-diligence answers copied only the tools' figures. TEST-PLAN CH.
- [x] C3 Renovation — mock and rules approved by the product team (2026-11-03): no cost figures from us; the AI
  picks only from the fixed kinds of work; photos give room types only; the buyer's quotes are compared in code;
  permit rules from official state sources. Step 1 done (uncommitted): `packages/core/src/renovation/` — 25 kinds
  of work (cost drivers, trades, permit triggers; a test refuses any figure), the plan and photo contracts
  (`checkPlan`, `photoRoomsSchema` strict, `roomsFromPhotos`), quotes in whole cents (`compareQuotes`), the
  per-state permit structure. Committed `5bd7be8`. Step 2: permit rules for VIC (9 triggers), NSW (8) and QLD (7)
  from their official pages, each on its own state's domain (a test enforces it); WA, SA, TAS, ACT, NT and the
  rest "not verified". Committed `e8b683e`. Step 3 (uncommitted): end to end — the planner and the room reader
  (packages/ai, summary tier, metered), `/api/renovation` and `/api/renovation/rooms` (rate limit, daily cap, the
  switch; the listing decides the state), `/renovation` (plan cards, permit notes with sources or "not verified",
  why no price, quotes compared by `compareQuotes`), "Planning a renovation?" on listings, `renovation_plan` in the
  guide (enum of the 25 kinds; prompt v13). Live model green 2026-11-03 (the user's go): the planner kept 3/3 kinds
  for a request that asked "what would it cost?" with no money in any line; the guide called renovation_plan and
  gave no price. TEST-PLAN CI.
- [ ] [ ] C4 · [ ] C5 · [ ] C6 · [ ] C7 · [ ] C8 · [ ] C9
