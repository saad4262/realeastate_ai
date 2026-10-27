# LocalAgentHub — Client Roadmap & Status

The client's full brief (the 28 "skills") and where the codebase stands on each.
Assessed 2026-10-26 from the code (refreshed the same day after ADR 0053–0056 landed on `main`) on `feat/platform-admin` (66 tables, the console pages, ~60
assistant tools, the workflow catalog, the integrations). **Percentages are estimates from
reading the code, not measured.** Update this file as each step lands.

The brief's numbering skips #20 and #25. The brief marks some items "Yellow = in the future"
(company data); the colours were not in the text we received — ask the client which ones.

---

## Part 1 — Status summary

| # | Skill | Done | State |
|---|---|---|---|
| 1 | Inbox | 35% | Email works; no SMS, calls, or reading the agent's Gmail |
| 2 | AI Business Intelligence Agent | 65% | ~60 tools + documents; proactive opportunities built (ADR 0054), migration 0062 not applied |
| 3 | Advanced CRM | 70% | Contacts + roles + buyer requirements (ADR 0055); no prospect/past-client/referral roles, no transactions |
| 4 | AI Contact Import | 65% | CSV/Excel/Sheets + dedupe + AI mapping and row fixes (ADR 0056); no CRM connectors |
| 5 | Smart Buyer Matching | 45% | New listing fitting a brief alerts the agent (`buyer_match`, ADR 0055 §6); no matched-buyers list/email |
| 6 | Seller Prospecting & Appraisals | 10% | `recent_sales` comparables only |
| 7 | Automated Follow-Ups | 45% | Via workflows (#27) |
| 8 | Email Marketing & Campaigns | 55% | Bulk email works; no AI segments, no SMS |
| 9 | AI Call & Voice Intelligence | 0% | No phone provider |
| 10 | Property & Customer Intelligence | 25% | Foundations only |
| 11 | Agency Knowledge Base | 45% | Built (ADR 0053): /knowledge, assistant answers from it; migration 0061 not applied |
| 12 | Team Collaboration | 40% | Messages, meetings, reassignment |
| 13 | Digital Documents | 45% | Built (ADR 0053): on contacts + listings, read (text/Word/scans), searched by the assistant; no e-sign |
| 14 | Transaction Management | 10% | Listing status only |
| 15 | Property Management | 5% | Rent listings + landlord/tenant roles only |
| 16 | Custom Dashboard Intelligence (URL) | 50% | Built; no commission/revenue data |
| 17 | AI Marketing Studio | 15% | Listing copy drafts only |
| 18 | Agency Funnel Builder | 10% | Public site exists; no builder |
| 19 | Integrations & Open API | 25% | 5 providers; no public API/webhooks |
| 21 | Natural-Language Search | 50% | Works for listings/notes/emails; the assistant still can't search buyer briefs |
| 22 | AI Custom Dashboards | 65% | Strongest part |
| 23 | AI Voice-Controlled Platform | 10% | Commands work by text; no voice input |
| 24 | Recruitment & Agent Onboarding | 50% | Invite wizard + offboarding |
| 26 | AI Social Media & Advertising Studio | 0% | — |
| 27 | AI Automation Engine | 35% | Engine built; no visual builder, few triggers |
| 28 | AI Missed Call — Voice & Text | 0% | No phone/SMS provider |

**Whole platform: ~33–35%** (was ~28–30% before ADR 0053–0056). The foundation is solid — auth, tenant isolation, `can()`
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
- [ ] **1.3 Assistant `find_buyers`**: reads `buyer_requirement`, so "buyers for a 3-bed in
  Pakenham under $800k" works and the answer shows how it searched (#21, #5).
- [ ] **1.4 Matched buyers on the listing**: the contacts whose brief fits the listing, plus
  one-click bulk email or a task for them, respecting consent (#5). Mock first.
- [ ] **1.5 More roles**: prospect, past client, referral partner (#3).
- [ ] **1.6 Turn inbound email on** (Resend MX + `MAIL_INBOUND_DOMAIN` + `MAIL_REPLY_SECRET`) and
  add an AI reply draft in the inbox that goes out only after the agent approves it (#1). Mock first.

### Phase 2 — Money
- [ ] **2.1 Transaction pipeline** (Appraisal → Listing → Marketing → Offers → Negotiation →
  Contract → Settlement) on the listing/property (#14). Mock first.
- [ ] **2.2 Commissions**, expected and completed, by agent, office, suburb and type. Fills
  `/finance`, and the measures go into the semantic layer so dashboards show revenue (#16, #22).
- [ ] **2.3 Property page** with everything on it: owners, enquiries, appraisals, offers,
  documents, pipeline, an AI summary (#10, #6).

### Phase 3 — Phone + SMS (needs the client's Twilio answers)
Setup is being settled with the client by the user (2026-10-27). Recommended: the platform's own Twilio
account with a subaccount per agency ("Get a number" in Connectors), and bring-your-own Twilio later as an
option. Missed calls reach Twilio by no-answer forwarding from the agency's existing numbers.
- [ ] **3.1 Twilio integration + SMS threads in the inbox** (#1, #8 SMS).
- [ ] **3.2 Missed call → SMS → qualify → alert the agent** (#28), plus a Missed Calls page. Mock first.
- [ ] **3.3 Call recording, transcript and summary; AI voice callback** where it is legal (#9, #28).

### Phase 4 — Automation engine (#27, #7)
- [ ] More triggers (CRM, property, communication, calendar, transaction, missed call), the
  "AI understands → decides" step, Automation Library templates, the Control Centre page, and all
  three permission levels. The visual builder comes last.

### Phase 5 — Open platform (#19)
- [ ] Public API + webhooks; Outlook; Xero; CRM connectors (Rex, VaultRE, AgentBox) for #4.

### Phase 6 — Marketing (#17 → #26 → #18)
- [ ] Marketing Studio + agency branding → Social & Ads (budget changes need explicit approval) →
  Funnel Builder.

### Phase 7 — The rest
- [ ] Voice control (#23), Property Management (#15), recruitment pipeline + training (#24),
  team workload board (#12).

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
