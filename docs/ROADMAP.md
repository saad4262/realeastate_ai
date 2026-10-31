# LocalAgentHub — Client Roadmap & Status

The client's full brief (the 28 "skills") and where the codebase stands on each.
Assessed 2026-10-26 from the code (refreshed the same day after ADR 0053–0056 landed on `main`) on `feat/platform-admin` (66 tables, the console pages, ~60
assistant tools, the workflow catalog, the integrations). **Percentages are estimates from
reading the code, not measured.** Update this file as each step lands.

The brief's numbering skips #20 and #25. The brief marks some items "Yellow = in the future"
(company data); the colours were not in the text we received — ask the client which ones.

---

## Part 1 — Status summary

| # | Skill | Done | State (2026-10-30) |
|---|---|---|---|
| 1 | Inbox | 55% | Email + inbox assistant (ADR 0062) + SMS texts on agents' Twilio numbers (ADR 0070); no Outlook, no reading the agent's Gmail |
| 2 | AI Business Intelligence Agent | 70% | ~60 tools + documents + proactive opportunities (ADR 0054) + find_buyers (ADR 0059) |
| 3 | Advanced CRM | 80% | Contacts, roles incl. prospect / past client / referral partner (ADR 0061), buyer requirements, property page (ADR 0065) |
| 4 | AI Contact Import | 65% | CSV/Excel/Sheets + dedupe + AI mapping and row fixes (ADR 0056); no CRM connectors |
| 5 | Smart Buyer Matching | 75% | Alert on a new listing + find_buyers + Matching buyers tab with email/task (ADR 0060); no SMS to them yet (3.4) |
| 6 | Seller Prospecting & Appraisals | 10% | `recent_sales` comparables only (property data provider not chosen) |
| 7 | Automated Follow-Ups | 50% | Via workflows (#27), now with more triggers |
| 8 | Email Marketing & Campaigns | 55% | Bulk email works; no AI segments; bulk SMS is 3.4 |
| 9 | AI Call & Voice Intelligence | 40% | AI call back with transcript, recording, summary (ADR 0072, PROVISIONAL until real Retell keys) |
| 10 | Property & Customer Intelligence | 40% | Property page with everything on it + AI summary (ADR 0065) |
| 11 | Agency Knowledge Base | 45% | Built (ADR 0053): /knowledge, assistant answers from it |
| 12 | Team Collaboration | 40% | Messages, meetings, reassignment |
| 13 | Digital Documents | 45% | On contacts + listings, read, searched; no e-sign |
| 14 | Transaction Management | 60% | Deal pipeline, 7 stages, conditions, settle (ADR 0063) |
| 15 | Property Management | 5% | Rent listings + landlord/tenant roles only |
| 16 | Custom Dashboard Intelligence (URL) | 65% | Built, with commission/revenue measures (ADR 0064) |
| 17 | AI Marketing Studio | 15% | Listing copy drafts only |
| 18 | Agency Funnel Builder | 10% | Public site exists; no builder |
| 19 | Integrations & Open API | 35% | Google, Zoom, Gmail send, Sheets, Reviews, Resend, Twilio (bring-your-own), Retell; no public API/webhooks |
| 21 | Natural-Language Search | 65% | Listings/notes/emails + buyers by brief (ADR 0059); smart search needs the Voyage key |
| 22 | AI Custom Dashboards | 75% | Strongest part; revenue measures now in |
| 23 | AI Voice-Controlled Platform | 10% | Commands work by text; no voice input |
| 24 | Recruitment & Agent Onboarding | 50% | Invite wizard + offboarding |
| 26 | AI Social Media & Advertising Studio | 0% | Pending (the user, 2026-10-29) |
| 27 | AI Automation Engine | 55% | 13 triggers, AI decides, Automation Library, every automation behind a Skills switch (ADR 0066–0069) |
| 28 | AI Missed Call — Voice & Text | 80% | Forwarding, greeting, text behind a skill, AI call back, Missed Calls page (ADR 0070–0072) |

**Whole platform: ~45%** (was ~33–35% on 2026-10-27). Phases 1 and 2 done; 3 and 4 nearly; 5–7 not started. See docs/HANDOFF.md.
permissions, platform admin, public site — so later work builds on it rather than around it.

### Built but not in the brief
- Public website: search, map, sold, AI chat about a property, saved-search alerts (consumers).
- Platform admin console (ADR 0049–0052): agencies, users, site activity, email, block a user.
- Google Reviews (ADR 0028). Meetings end to end with Zoom (ADR 0032, 0038).

---

## Part 2 — Each skill in detail (what it does, flow, built, missing)

### 1. Inbox — 35%
One place for all agent/agency communication; AI summarises and drafts replies.
Flow: message arrives → matched to contact → AI summary → draft reply → agent sends.
- **Built:** per-lead email threads (`mail_thread`, `mail_message`); `/inbox` (agency) and
  `/my-inbox` (agent); compose new email (ADR 0035); Gmail **send-only** (ADR 0026); inbound
  replies via Resend into the same thread (ADR 0016); `important_emails` skill.
- **Not live:** inbound is off until `MAIL_INBOUND_DOMAIN` + `MAIL_REPLY_SECRET` + Resend MX are set.
- **Missing:** reading the agent's real Gmail inbox (needs read scope), Outlook, SMS, calls,
  AI reply drafts in the inbox. (Attachments are now stored as documents — ADR 0053.)

### 2. AI Business Intelligence Agent — 65%
An AI employee: finds information, answers, creates tasks, drafts emails, finds opportunities, reports.
Flow: agent asks → AI picks a tool → numbers come from SQL → answer/card → agent approves.
- **Built:** assistant (ADR 0025, 0039, 0040, 0041) with tools incl. `find_contacts`,
  `find_leads`, `find_listings`, `search_notes_and_emails`, `query_data`, `describe_data`,
  `create_reminder`, `plan_task`, `schedule_appointment`, `schedule_team_meeting`,
  `send_email`, `send_template_email`, `create_dashboard`, `create_workflow`, `set_up_skill`,
  `recent_sales`, `create_listing_draft`, `invite_agent`, `remove_agent`. Skills:
  `morning_brief`, `important_emails`, `template_email`.
- **Built since:** proactive opportunities (ADR 0054); documents + knowledge as sources (ADR 0053).
- **Missing:** reports beyond dashboards; searching buyer briefs (`find_buyers`, Phase 1.2).

### 3. Advanced CRM — 70%
Every relationship: buyers, sellers, landlords, tenants, investors, prospects, past clients,
referral partners — full profile.
- **Built:** `contact` (assign, archive, merge, consent, opt-out, next action), `contact_role`
  (seller, buyer, landlord, tenant, investor), `contact_property` (owner…), `note`,
  `activity` timeline, `appointment`, leads, mail.
- **Built since:** buyer requirements (ADR 0055): a Requirements tab with up to 10 briefs per
  contact; documents on the profile (ADR 0053).
- **Missing:** roles prospect / past client / referral partner; transactions on the profile.

### 4. AI Contact Import & Migration — 65%
Flow: upload → map columns → dedupe → preview → import.
- **Built:** CSV, Excel, Google Sheets (`packages/core/src/imports`); mapping screen; dupes by
  email + phone key; roles column; dry run then commit.
- **Built since:** AI column mapping (masked samples) and opt-in AI fixes for failing rows (ADR 0056).
- **Missing:** AI categorising; connectors to existing CRMs (Rex, VaultRE, AgentBox…).

### 5. Smart Buyer Matching — 45%  (+ option: extra data from the realtime real-estate AI platform)
Flow: new listing → AI searches CRM for matching buyers → list with details → email/SMS/call.
- **Built:** consumer saved-search alerts on the public site; a workflow can fire on listing status.
- **Built since:** the `buyer_match` detector: a new listing that fits an active brief alerts the agent (hourly).
- **Missing:** the matched-buyers list on the listing and email/SMS/call to them (Phase 1.3).

### 6. Seller Prospecting & Appraisals — 10%  (+ option as above)
Flow: AI spots likely sellers from CRM/conversations → list → appraisal management →
comparable sales → seller presentation → proposal → follow-up.
- **Built:** `appraisal` appointment type and lead kind; `recent_sales` (comparables from SQL).
- **Missing:** seller detection, appraisal management, presentations, proposals.

### 7. Automated Follow-Ups — 45%
New enquiry, missed call, inspection, appraisal, buyer match, past client. Agent approves/configures.
- **Built (via #27):** `lead.created`, `lead.no_reply`, `appointment.booked`,
  `lead.status_changed`; send windows; draft-for-approval or approved template.
- **Missing:** missed call, inspection follow-up, past-client, buyer-match triggers.

### 8. Email Marketing & Campaigns — 55%  (bulk email now; SMS and calls later)
- **Built:** `/bulk-email`, `email_template`, `email_batch`, `contact_filter`, consent/opt-out.
- **Missing:** AI-personalised campaigns by segment (listing, suburb, buyer/seller), SMS, calls.

### 9. AI Call & Voice Intelligence — 0%
Transcribe, summarise, extract notes/tasks, update CRM for approval; AI makes and answers calls.
Nothing built; no telephony provider.

### 10. Property & Customer Intelligence — 25%
Every property's connected history: owners, interested buyers, enquiries, appraisals, listings,
offers, documents; AI helps spot who may buy/sell.
- **Built:** `property` ≠ `listing`; relist history (ADR 0013); owners via `contact_property`;
  leads per listing; private offers (ADR 0012).
- **Missing:** one property page with everything; AI property summary; appraisals/documents on it.

### 11. Agency Knowledge Base — 45%
Procedures, policies, templates, scripts, branding, training; AI answers from it. Built: /knowledge (ADR 0053).

### 12. Team Collaboration — 40%
- **Built:** team messages, team meetings, assignment, offboarding reassignment (ADR 0030),
  agents widget (ADR 0034), assistant tasks.
- **Missing:** shared task board, workload view, overdue overview, daily tasks scheduled for every member.

### 13. Digital Documents — 45%
Contracts, reports, proposals against contact/property/transaction; AI extracts/summarises. Built on
contacts + listings (ADR 0053); no e-sign, not on transactions yet.

### 14. Transaction Management — 10%
Appraisal → Listing → Marketing → Offers → Negotiation → Contract → Settlement.
- **Built:** listing status (live, under_offer, sold, withdrawn); private offers.
- **Missing:** the pipeline, contract, settlement, AI "where is every property at".

### 15. Property Management — 5%
Landlords, tenants, leasing, inspections, maintenance — may integrate with specialist systems first.
Only rent listings and landlord/tenant roles exist.

### 16. Custom Dashboard Intelligence (real time, with URL) — 50%
Expected/completed commissions, revenue by agent/office/suburb/type; anything to monitor live.
- **Built:** dashboards from any request (ADR 0027, 0036, 0044, 0047); link per dashboard
  (`/dashboards/[id]`, fills a TV); semantic layer.
- **Missing:** commission/revenue data — `/finance` is a placeholder.

### 17. AI Marketing Studio — 15%
Descriptions, social posts, emails, brochures, video scripts, open-home, sold campaigns,
market reports — on brand.
- **Built:** AI listing copy as a draft (non-negotiable 7); assistant writes emails.
- **Missing:** everything else; agency branding store.

### 18. Agency Funnel Builder — 10%
Agency ad pages, agent profiles, property pages, landing pages, lead forms, wired to the CRM.
Public site exists (platform's own); no builder.

### 19. Integrations & Open API — 25%
- **Built:** `google_calendar`, `zoom`, `google_sheets`, `google_reviews`, `gmail` (send);
  Resend for email.
- **Missing:** Outlook, Xero, SMS, phone systems, property data, e-signatures, marketing
  platforms, existing CRMs, PM systems, **public API + webhooks** ("from day one" per brief).

### 21. Natural-Language Search — 50%
"Find buyers looking for a 3-bedroom house in Pakenham under $800,000" → transparent search.
- **Built:** hybrid search (ADR 0031, pgvector) over listings, contacts, notes, emails; `query_data`.
- **Missing:** the brief's own example fails — buyer requirements aren't stored (#3).

### 22. AI Custom Dashboards — 65%
"How did the agency perform this quarter?" → analysis, charts, summary, link.
- **Built:** request → dashboard with link → change it in its own chat (ADR 0036, 0042, 0044, 0047).
- **Missing:** revenue/commission measures.

### 23. AI Voice-Controlled Platform — 10%
"What appointments do I have today?", "Remind me to call John tomorrow". All work as text; no voice input/output.

### 24. Recruitment & Agent Onboarding — 50%
- **Built:** invite wizard (licence no./class/expiry, territory, specialties, languages,
  commission split, operational role, permission flags); edit/remove member (ADR 0033);
  departure with lead/listing reassignment (ADR 0030).
- **Missing:** recruitment pipeline, training, office assignment flow.

### 26. AI Social Media & Advertising Studio — 0%
Facebook, Instagram, TikTok, YouTube/Shorts, Google ads. AI creates video/image/carousel ads,
captions, headlines, CTAs, hashtags, thumbnails, audience variants. Agent reviews before publish.
Optimisation: best creative/audience/location, pause, budget shift — **budget changes need explicit
agency approval**. Ads dashboard (Draft/Scheduled/Active/Paused/Completed; spend, reach,
impressions, clicks, enquiries, leads, appointments, CPL, conversion). One-click "Create AI
Campaign" from a listing with objectives: buyer enquiries, open home, seller leads, appraisal
service, recently sold, local brand. Not built.

### 27. AI Automation Engine — 35%
WHEN → IF → AI understands/decides → THEN → approval → execute → log.
- **Built (ADR 0041, 0048; `packages/core/src/workflows/catalog.ts`):**
  - Triggers (6): `lead.created`, `lead.status_changed`, `lead.no_reply`,
    `appointment.booked`, `listing.status_changed`, `contact.created`.
  - Conditions: suburb, sale/rent, within N km, lead kind/source, assignee, contact role,
    appointment type, contact name, listing.
  - Actions (11): add_note, set_next_action, remind_owner, set_lead_status, assign_lead,
    assign_contact, message_colleagues, send_template_email, draft_email, wait, wait_until.
  - Approval (`proposed_action`), runs log (`workflow_run`), limits, made from chat.
- **Missing:** visual builder; the brief's other ~50 triggers; the "AI understands → decides"
  step; Automation Library/Marketplace; Control Centre page; 3 permission levels in full
  (🟢 automatic / 🟡 approval / 🔴 human only — partly there: template send vs draft).

### 28. AI Missed Call — Voice & Text — 0%
Missed call → identify caller → CRM lookup → intent → SMS → AI voice callback → qualify →
update CRM → assign/notify agent → follow-up. Not built; needs telephony + SMS.

---

## Part 3 — Work order (step by step)

### Decisions (the user, 2026-10-26)
- **Start with Phase 1**: finish what is half built before adding any new provider.
- **Group the agency sidebar** by the brief's architecture (layout below). Every new page goes
  into its group; pages that aren't built yet are not shown.
- **Mock first, then build**: each bigger skill gets an HTML mock in `docs/mocks/` (like
  `listing-detail.html`). The user or client approves it, then we write the ADR, then the code.
- **Ask the client about Twilio/phone now** (account owner, AU number, call-recording consent,
  monthly budget), so Phase 3 doesn't sit waiting on the answers.

Agency sidebar groups (`apps/console/components/shell/surfaces.ts`; [ ] = later):
Home (Overview, LocalAgent AI) · Daily work (Leads, Inbox, Calendar, Projects) · People (Customers,
Agents & Team) · Properties (Listings, [Transactions]) · Marketing (Bulk email, Marketing & Reviews,
[Ads]) · Automation ([Control Centre], Workflows, Skills) · Knowledge & insights (Knowledge base,
Dashboards, Insights) · Money (Finance & Trust) · Settings (Connectors, Settings).
The agent sidebar uses the same groups.

### Done
- [x] Documents (#13) + Knowledge Base (#11): ADR 0053, migration 0061.
- [x] Proactive opportunities (#2): ADR 0054, migration 0062.
- [x] Buyer requirements (#3) + a matching alert to the agent (#5): ADR 0055, migration 0063.
- [x] AI contact import, mapping + row fixes (#4): ADR 0056, migration 0064.

### Phase 1 — Finish what is half built (no new provider)
- [x] **1.1 Sidebar groups** (committed with 1.2; the user checked it in a browser) in both the agency and agent shells. ADR 0057, 2026-10-27, branch
  `feat/sidebar-groups`; TEST-PLAN BK. Projects (= dashboards) sits in Knowledge & insights, Team
  messages in Daily work; Insights now opens /insights; the dead agent "Offers" link is gone.
- [x] **1.2 Skills Control Centre** (2026-10-27, ADR 0058, migration 0065 applied, committed with 1.1;
  TEST-PLAN BL). One Skills page with tabs: Platform skills · AI skills · Automations (Workflows moved in).
  16 built capabilities each have an on/off switch; the agency's switch and each agent's are independent
  (the user: no override for now). Agents never see the 3 agency-only skills. Off = refused in the
  assistant, skipped by the opportunity scan and workflow drafts, and stopped on the bulk email and import
  screens. The assistant flips a switch with `switch_skill` (approval card, prompt v26). Mock approved:
  `docs/mocks/skills-control-centre.html`.
- [x] **1.3 Assistant `find_buyers`** (2026-10-27, ADR 0059, no migration, committed; the user checked it; TEST-PLAN BM): reads `buyer_requirement`, so "buyers for a 3-bed in
  Pakenham under $800k" works and the answer shows how it searched (#21, #5).
- [x] **1.4 Matched buyers on the listing** (mock approved 2026-10-27; ADR 0060 — tabs on the listing page, listing
  merge fields frozen at Prepare, one call task, strict consent; built 2026-10-27, migration 0066 applied, automated
  checks green, not committed until the user walks TEST-PLAN BN): the contacts whose brief fits the listing, plus
  one-click bulk email or a task for them, respecting consent (#5). Mock first.
- [x] **1.5 More roles**: prospect, past client, referral partner (#3). Built 2026-10-27, ADR 0061, migration 0067
  applied 2026-10-28, not committed; TEST-PLAN BO. None of them gives marketing consent.
- [x] **1.6 Inbox assistant** (2026-10-27, ADR 0062, no migration, not committed; TEST-PLAN BP): a summary and
  a reply draft over the reply box, each on a button, checked by core, sent only by the agent (#1). Turning
  inbound email on is configuration only (DEPLOY.md "Email conversations": MX + `MAIL_INBOUND_DOMAIN` +
  `MAIL_REPLY_SECRET`) — the user's to do; the code was built in ADR 0016.

### Phase 2 — Money
- [x] **2.1 Transaction pipeline** (built 2026-10-27, ADR 0063, migration 0068 applied 2026-10-28, not committed; TEST-PLAN
  BQ — 7 fixed stages, sales only, Mark sold → Contract with Settlement separate, 4 standard conditions + the
  agent's own, a minute sync that opens and moves deals, a Pipeline board, the listing's Deal tab, find_deals) (Appraisal → Listing → Marketing → Offers → Negotiation →
  Contract → Settlement) on the listing/property (#14). Mock first.
- [x] **2.2 Commissions** (built 2026-10-27, ADR 0064, columns in migration 0068 applied 2026-10-28, not committed; TEST-PLAN
  BR — the agency sets it; excl. GST with GST alone; profile split by default, changeable per deal; FY July–June),
  expected and completed, by agent, office, suburb and type. Fills
  `/finance`, and the measures go into the semantic layer so dashboards show revenue (#16, #22).
- [x] **2.3 Property page** (built 2026-10-27, ADR 0065, no migration (reads 0068's deal, applied), not committed; TEST-PLAN
  BS — agents only their own addresses and records, a Properties list, the summary on a button and never saved, tabs)
  with everything on it: owners, enquiries, appraisals, offers, documents, pipeline, an AI summary (#10, #6).

### Phase 3 — Phone + SMS: Call Forwarding + Verified Caller ID
Decided 2026-10-29 (the user, with the client): **each agency brings its own Twilio account**, and the
platform's own **Retell** account runs the AI calls. Agents keep their own phones and SIM cards; only the
calls they miss reach Twilio. The flow:
1. **Connect.** The owner connects the agency's Twilio under Connectors with an API key (Account SID +
   API key SID + secret), stored encrypted like the other integrations (`INTEGRATION_TOKEN_KEY`). One Twilio
   account per agency, never per agent.
2. **Business check.** Twilio's Australian KYC (ABN/ACN, ASIC long-form company extract, an AU address
   that is not a PO Box plus proof, the authorised person's ID) is done by the agency in Twilio. The app
   reads the status, says what is missing, and emails the owner when it is approved.
3. **Numbers.** Only after approval, the app buys **one AU mobile number per agent** through that key (so it
   knows whose call was missed), and sets its SMS/voice webhooks and the SIP trunk to Retell.
4. **Verified Caller ID.** Each agent verifies their own mobile in Twilio (Twilio calls, the agent keys the
   code the app shows), so the AI's callback shows the agent's real number.
5. **Forwarding.** The agent turns on Call Forwarding on No Answer to their Twilio number (the app shows
   their carrier's code), then the app runs a test call.
6. **A missed call.** The caller hears a short greeting (forwarding replaces voicemail) → a template SMS
   from the Twilio number → CRM lookup by phone → Retell calls back from the agent's real number within
   calling hours → transcript, summary and lead update on the contact → the agent is alerted. SMS replies
   land in the contact's inbox thread.

Agreed corrections: SMS cannot use a verified caller ID, so texts come from the Twilio number and name the
agent; numbers can be bought only after KYC approval; one number per agent; the forwarded caller hears a
greeting. **Test first:** a verified caller ID on outbound SIP calls on Australian networks (fallback: the
callback comes from the Twilio number). **Later option:** platform-managed numbers (a Twilio subaccount per
agency) once Stripe billing exists.

**Open decision for the ADR — non-negotiable 7.** The AI callback is model-written speech reaching a third
party with no human in between. Proposed bounds: off by default and turned on by the owner; the AI says it
is an AI assistant for the agent; it only asks what the call is about and offers a callback time, and never
gives prices, valuations or promises; a recording notice starts every call; one text and one AI call per
caller per 24 h; only people who called; nobody who replied STOP. The SMS is a template the owner approves.

**Skills (ADR 0069, the client 2026-10-29):** every automation lives in Skills and runs only when switched
on. Phase 3 adds two skills, Missed call text and AI calls back, that run for an agent only when the agency's
switch AND the agent's own are on. Connecting Twilio sets up phones only; nothing is texted or called before.

Mocks (awaiting the client's approval): `docs/mocks/twilio-setup.html`, `docs/mocks/missed-calls.html`,
`docs/mocks/skills-control-centre.html` (updated).
Waiting on the client: a test Twilio account with KYC approved, the Retell API key, a real mobile for
forwarding tests. Voyage key and the temporary domain arrive at the same time (config only).
- [x] **3.1 Twilio connector + SMS threads in the inbox** (#1, #8 SMS): API key, KYC status, a number per
  agent, caller ID verification, forwarding guide and test call. Mock: `twilio-setup.html`. Built 2026-10-30,
  ADR 0070, migration 0071 applied, real keys not yet (dev stub `PHONE_STUB=1`); TEST-PLAN BX.
- [x] **3.2 Missed call → greeting → SMS → CRM lookup → alert the agent** (#28), the Missed Calls page and
  its settings (SMS template, greeting, calling hours, limits). Mock: `missed-calls.html`. Built 2026-10-30, ADR
  0071, migration 0072 applied; skill `missed_call_text` (agency + agent); calling hours move to 3.3 (they
  only govern AI calls); TEST-PLAN BY.
- [x] **3.3 Retell AI callback** from the agent's verified number; recording, transcript and summary on the
  contact (#9, #28). Built 2026-10-30, ADR 0072, migration 0073 applied, Retell keys not yet (dev stub);
  calls from the agent's Twilio number for now (their mobile as caller ID is still to test); TEST-PLAN BZ.
- [ ] **3.4 SMS everywhere:** matched buyers, bulk SMS (consent + STOP), the workflow "Send SMS" action and
  the "Missed call" trigger (#5, #8, #27). Part 1 built 2026-10-31 (ADR 0074, migration 0074 applied): templates
  by channel (no email path sends an SMS one), SMS parts and the STOP footer, the `call.missed` trigger. Part 2
  waits for the client's five rules (mock `sms-everywhere.html`).

### Phase 4 — Automation engine (#27, #7)
- [x] **4.1 More triggers** (built 2026-10-28, ADR 0066, migration 0069 applied, committed; TEST-PLAN BT —
  deal stage / settled with the side chosen per workflow, buyer match, before / after an appointment, appraisal
  not listed, sale anniversary; the email rule unchanged). Missed call comes with Phase 3.
- [x] **4.2 AI decides** (built 2026-10-28, ADR 0067, column in migration 0069 applied, committed; TEST-PLAN
  BU — one decision at the start, from the enquiry and its latest email; the workflow's own steps are "Not sure";
  steps run by themselves and the run's log says what the AI chose and why).
- [x] **4.3 Automation Library** (built 2026-10-28, ADR 0068, no migration, not committed; TEST-PLAN BV — ten
  ready-made automations on the Automations tab for owners and admins, set up through the assistant).
- [x] **4.5 AI understands, then decides** (A + B + C; built 2026-10-31, ADR 0078, migration 0078 applied; TEST-PLAN CD —
  every new enquiry understood while the skill is on: type, urgency, summary, the brief with each figure found in
  the enquiry's words; saved to a contact only through an approval card; conditions lead.intent / lead.urgency and
  the step "Save the brief the AI found"). Mid-run decisions are 4.5b. Mock `ai-understands.html` (the user approved).
- [ ] More triggers (CRM, property, communication, calendar, transaction, missed call), the
  "AI understands → decides" step, Automation Library templates, the Control Centre page, and all
  three permission levels. The visual builder comes last.

**Version 1 / version 2 (the user, 2026-10-31):** Phase 6 (Marketing, all of it), Xero and the CRM connectors
are **version 2** — not built now. Everything else on this list is version 1: 3.4, the rest of Phase 4, the
public API + webhooks, Outlook, and Phase 7.

### Phase 5 — Open platform (#19)
- [ ] Public API + webhooks. (v1)
- [x] **5.2 Outlook** (built 2026-10-31, ADR 0076, migration 0077 applied; TEST-PLAN CC — send from Outlook,
  Outlook Calendar mirror, work and personal Microsoft accounts, one of each in use per person, a calendar
  switch moving only what is ahead). Real Microsoft needs the Entra app (DEPLOY.md) — PROVISIONAL until tried.
- [ ] Xero; CRM connectors (Rex, VaultRE, AgentBox) for #4. **Version 2.**

### Phase 6 — Marketing (#17 → #26 → #18) — **Version 2**
- [ ] Marketing Studio + agency branding → Social & Ads (budget changes need explicit approval) →
  Funnel Builder.

### Phase 7 — The rest
- [ ] Voice control (#23), Property Management (#15), recruitment pipeline + training (#24),
  team workload board (#12).

### Technical debt (known flaws; an ADR each before the fix)
Both items below: FIXED by ADR 0075 (option A, the user 2026-10-31), deployed, migrations 0075 + 0076 applied.
Found 2026-10-31 while seeding the phone test agency; the user confirmed both as critical for Australian
open listings (one home listed by several agencies at once).
- [x] **A listing rewrites another agency's property.** `property` rows are shared by address across every
  agency (`upsertProperty`). Creating or editing a listing at an address that already has a row overwrites
  that row's pin (a carried pin always wins, and a manual one clears `place_id` / `formatted_address`) and
  its provided physical facts (type, bedrooms, bathrooms, car spaces) — for every agency that uses it.
  Seen: a test listing at 27 Lakeside Blvd, Pakenham rewrote agency Alpha's row (Alpha's owner re-picks the
  address to restore Google's pin).
- [x] **One open deal per property across all agencies.** `deal`'s unique index is on `property_id` where
  open, not on `(agency_id, property_id)`, and the sync's `on conflict (property_id) … do nothing` drops the
  second agency silently: its listing never gets a deal, a Pipeline card or Finance figures.

Each step: a mock (if it has new UI) → ADR → code → TEST-PLAN → tick it here and update Part 1.
The order is a recommendation; the client/user decides.

---

## Part 4 — The client's brief (condensed, nothing dropped)

**Vision:** the agency's whole business intelligence in one place — Inbox, Contacts, Buyers,
Sellers, Landlords, Tenants, Properties, Listings, Leads, Appointments, Transactions,
Documents, Financial information, AI-generated intelligence.

**Final architecture:** CRM → knows WHO · Property System → WHAT · Communication → WHAT WAS SAID ·
Calendar → WHAT IS HAPPENING · Marketing → WHAT IS BEING PROMOTED · Transactions → WHAT IS BEING
SOLD · AI → WHAT IT ALL MEANS · Automation Engine → WHAT SHOULD HAPPEN NEXT · Social Advertising →
IN FRONT OF THE RIGHT PEOPLE. All of it feeds back into the same system — not "another agency CRM".

1. **Inbox** — business email, enquiries, SMS, calls, messages; full history per contact. AI reads
   authorised email, summarises, finds opportunities, drafts replies; phone calls later.
2. **AI Business Intelligence Agent** — understands emails, CRM, listings, calendar, documents.
   Finds info, answers, creates tasks, drafts emails, finds opportunities, prepares reports. A skill
   that works out what needs doing and how to improve the business.
3. **Advanced CRM** — buyers, sellers, landlords, tenants, investors, prospects, past clients,
   referral partners. Profile: contacts, properties, emails, appointments, notes, tasks, documents,
   transactions, relationship history. The full picture.
4. **AI Contact Import & Migration** — CSV/Excel or connect existing systems. AI cleans, finds
   duplicates, maps fields, categorises, prepares.
5. **Smart Buyer Matching** — new listing → AI finds matching CRM buyers → list with details →
   email/text/call. "+" option: extra info from the realtime real-estate AI platform.
6. **Seller Prospecting & Appraisals** — AI finds selling opportunities from CRM + past
   conversations → list → appraisal management, comparable sales, seller presentations,
   proposals, follow-up. "+" option as above.
7. **Automated Follow-Ups** — new enquiry, missed call, inspection, appraisal, buyer matching,
   past client. Agents approve/configure before actions occur.
8. **Email Marketing & Campaigns** — bulk email now, SMS + calls later. AI personalised campaigns
   by listings, buyers, sellers, suburbs, approved segments.
9. **AI Call & Voice Intelligence** — where legally authorised: transcribe, summarise, extract,
   notes, follow-up tasks, CRM updates for approval; AI makes and answers calls.
10. **Property & Customer Intelligence** — each property's history: owners, interested buyers,
    enquiries, appraisals, listings, offers, documents. AI shows everything that happened and
    whether anyone may buy/sell.
11. **Agency Knowledge Base** — procedures, policies, templates, scripts, branding, training;
    AI answers from the agency's approved knowledge.
12. **Team Collaboration** — share tasks, contacts, listings, calendars, notes, leads. AI for
    handovers, workload, overdue tasks; schedules daily tasks for every member.
13. **Digital Documents** — contracts, reports, proposals, forms against contact/property/
    transaction. AI extracts, summarises, flags missing info.
14. **Transaction Management** — Appraisal → Listing → Marketing → Offers → Negotiation →
    Contract → Settlement; everything together; AI tells where every property is at.
15. **Property Management** — landlords, tenants, rentals, leasing, inspections, maintenance,
    rental communication; integrate with specialist systems first.
16. **Custom Dashboard Intelligence (real time, with URL)** — expected/completed commissions,
    revenue by agent, office, suburb, property type; AI trends; anything to monitor live.
17. **AI Marketing Studio** — descriptions, social posts, emails, brochures, videos/scripts,
    open-home, sold campaigns, market reports; agency branding.
18. **Agency Funnel Builder** — ad pages, agent profiles, property pages, landing pages, lead
    forms; AI builds pages for any purpose, wired to the CRM.
19. **Integrations & Open API** — Gmail, Outlook, Google Calendar, Xero, SMS, phone systems,
    property data, digital signatures, marketing platforms, existing CRMs, PM systems. Strong API +
    webhooks from day one.
21. **Natural-Language Search** — "Find buyers looking for a 3-bedroom house in Pakenham under
    $800,000" → transparent search + results.
22. **AI Custom Dashboards** — "How did the agency perform this quarter?", "Which agents
    generated the most appraisal opportunities?" → analysis, charts, summary, link.
23. **AI Voice-Controlled Platform** — "What appointments do I have today?", "Remind me to call
    John tomorrow", "Find buyers for this listing", "Summarise my outstanding leads".
24. **Recruitment & Agent Onboarding** — recruitment, onboarding, licence, permissions, office,
    training, CRM access, departure, lead/listing reassignment.
26. **AI Social Media & Advertising Studio** — see Part 2 #26 (platforms, assets, example
    "14 Smith Street, Pakenham" → Facebook ad / 20-sec TikTok / YouTube walkthrough, AI
    optimisation e.g. "Version B generated 38% more qualified enquiries → shift budget", budget
    changes need explicit approval, ads dashboard, one-click campaign with objectives).

### 27. AI Automation Engine (core technology, not a page)
Pipeline: TRIGGER → CONDITIONS → AI ANALYSIS → ACTIONS → APPROVAL → EXECUTION → LOG.
Principle: not IF → THEN but **IF → UNDERSTAND → DECIDE → ACT** (AI understands the email,
decides buyer/seller/landlord/general, checks CRM, finds info, prepares action, agent approves
if required, system executes, CRM records everything).

Examples:
1. New buyer enquiry → AI extracts requirements, budget, suburbs, type, timeline → create/update
   contact → buyer category → matching properties → personalised email → approval → send →
   follow-up task → log.
2. New listing published → analyse → match buyers → buyer emails → Facebook campaign → TikTok
   video → YouTube Short → schedule posts → open-home campaign → agent tasks.
3. Potential seller identified (AI) → condition: indicated interest → analyse conversations →
   seller opportunity → appraisal invitation → follow-up task → notify agent → approval → send.
4. Buyer attends inspection → record attendance → AI match → follow-up message → ask feedback →
   update profile → if strong interest → notify agent → task.
5. Email sent → no response 3 days → AI reviews → different follow-up → still none → agent task
   (stops AI repeatedly sending unwanted messages).
6. Enquiry after 6 PM → AI urgency → if high priority → approved acknowledgement → notify on-call
   agent → morning follow-up → pipeline. A 24/7 AI front door that doesn't pretend to be human.

Triggers wanted:
- CRM: contact created/updated, category changed, becomes inactive, becomes high priority,
  duplicate detected, new prospect, buyer requirement changed, seller opportunity identified.
- Property: property created, listing published, price changed, status changed, sold, withdrawn,
  open home created/completed.
- Lead: new, assigned, accepted, not contacted, stage changed, qualified, inactive.
- Communication: new email, received, sent, no response, bounced, customer replies, unsubscribes.
- Calendar: appointment created, approaching, completed, cancelled, no-show.
- Transaction: offer received, offer accepted, contract signed, settlement approaching, completed.
- Marketing: campaign created, published, reaches threshold, underperforming, new enquiry,
  cost per lead exceeds threshold.
- AI: AI-detected events (e.g. potential seller) as triggers.
- Missed call detected (#28).

Actions wanted: create/update contact, add tag, change lead stage, assign agent, create task,
create appointment, send/draft email, send SMS, create campaign, publish social post, generate
property description, generate video, generate report, notify agent/manager, find matching
buyers, generate appraisal, create document, update pipeline, schedule follow-up, request
approval, call external API, trigger another automation.

Automation Library templates — Sales: new buyer lead, new seller lead, new appraisal, new
listing, price reduction, sold, open-home follow-up, offer follow-up. CRM: new contact, duplicate,
inactive, missing info, birthday, past-client, referral. Marketing: new listing social, sold,
open-home, market update, suburb, seller prospecting. Property management: new landlord, new
tenant, lease expiry, rental enquiry, inspection follow-up, maintenance. Management: agent
performance, weekly agency, monthly principal, overdue tasks, uncontacted leads. "Use
automation" → customise.

Control Centre: today's counts (executed, tasks created, emails prepared/sent, opportunities,
approvals waiting, failed); click any event → trigger → what AI understood → decided → did →
who approved → result. Auditability is essential.

Permission levels: 🟢 Automatic (task, tag, categorise, summary, report) · 🟡 Approval required
(important customer email, significant CRM change, publish ads, appraisal proposal) · 🔴 Human
only — AI recommends, cannot execute (financial commitments, contracts, legal, critical
permissions, deleting major data).

### 28. AI Missed Call — Voice & Text Automation
Connect agency + agent phones. Flow: call → not answered → detect → identify caller → CRM →
context → personalised SMS → AI voice/text follow-up → create/update CRM → assign/notify →
continue follow-up.
- Example: seller calls 7:42 PM → SMS "Hi John, thanks for calling … We missed your call. How
  can we help?" → "thinking about selling in Pakenham" → find profile, seller opportunity,
  property, approved qualification questions, timeframe, offer appraisal, appraisal request,
  notify agent, record conversation.
- AI voice callback (if configured and legal), ~30 s after the miss; caller must clearly know it
  is an AI; agency configures when callbacks are allowed.
- Caller recognition: existing contact (role, assigned agent, last contact, property,
  opportunity, previous conversations) vs new caller → New Prospect + qualification.
- Workflows per type: buyer, seller, landlord, tenant, existing client (notify assigned agent at
  once), unknown (AI asks, categorises, routes).
- SMS config: immediate (0–1 min, `{{first_name}}`), follow-up after a set period, high-priority
  agent alert ("🔴 High Priority Missed Call … [Call Now] [View Contact]").
- Qualification uses known CRM data ("I have your budget around $700k–$800k. Has that changed?").
- Handover: AI knows when to stop ("I'd like to speak to Sarah") → routes to Sarah with AI summary.
- Call intents: buy, sell, rent, property management, existing client, inspection, offer,
  valuation, complaint, general, urgent, agent-to-agent, vendor/referral partner.
- Priority score (e.g. 98 urgent seller, 91 active buyer, 74 existing client, 42 general) —
  must be explainable, from configured business rules.
- Missed Calls dashboard: caller, time, type, priority, AI status, agent; click → Call → SMS →
  AI conversation → CRM → agent → follow-up → outcome.
- As an automation trigger with conditions (known caller, active client, intent, after hours,
  office, agent, repeat misses, priority) and actions (SMS, AI conversation, callback, CRM
  create/update, assign, task, notify, email, schedule, start another automation).
- Key principle: the phone call becomes data automatically — missed call → AI responds →
  understands → records → qualifies → routes → alerts → follows up → agent takes over.
