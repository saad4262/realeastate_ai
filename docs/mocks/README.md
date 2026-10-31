# Design mocks

The source of truth for what the public pages are supposed to look like.

This directory exists because the mock was lost once. The consumer pages were
built from it, the values were deliberately changed, the reason was recorded —
and when the result was questioned there was nothing in the repository to
compare against, because whatever had been pasted into a chat window was gone.
Rebuilding meant guessing from two screenshots, and the guess was wrong: warm
crimson on neutral grey, where the mock is cool slate with `#E11D48`.

**Anything a page is built to belongs in here, committed.**

## What is here

| File                   | Screen                                                |
| ---------------------- | ----------------------------------------------------- |
| `listing-detail.html`  | 12/1A Rogers Street, Pakenham VIC 3810 — Property Listing |
| `listing-detail.png`   | The same screen, rendered (1400 × 5296)               |
| `skills-control-centre.html` | Console: Skills (platform skills, AI skills, automations), agency and agent views. Hand-made for ROADMAP 1.2, sample data. Approved 2026-10-27; built as ADR 0058. Updated 2026-10-29 for ADR 0069: every skill off until switched on, Workflow emails, and a Phone & SMS group whose skills need the agency's and the agent's switch (awaiting the client's approval) |
| `matched-buyers.html` | Console: a listing's Matching buyers tab, the Buyers column on Listings, and the Email-them dialog (owner and agent views; `#list` / `#email` open those screens). Hand-made for ROADMAP 1.4, sample data. Approved 2026-10-27; ADR 0060 |
| `inbox-ai-reply.html` | Console: a conversation with the assistant's summary (each point citing its message) and a reply drafted into the composer; the switched-off state. `#draft` opens the drafted state. Hand-made for ROADMAP 1.6, sample data. Approved 2026-10-27 (summary on a button); ADR 0062 |
| `deal-pipeline.html` | Console: the Pipeline board (7 stages, owner and agent views) and a listing's Deal tab (stages, the sale, conditions, history, Settle dialog). `#deal` opens the tab. Hand-made for ROADMAP 2.1, sample data. Approved 2026-10-27; ADR 0063 |
| `commissions.html` | Console: the Finance page (earned / expected / shares / paid out, by agent, suburb, type and deal; owner and agent views) and the Deal tab's Commission panel. `#deal` opens the panel. Hand-made for ROADMAP 2.2, sample data. Approved 2026-10-27; ADR 0064 |
| `property-page.html` | Console: one property with everything on it (summary on a button, what has happened, pipeline, people, enquiries and offers, appraisals and visits, documents, history; owner and agent views) and the Properties list. `#list` opens the list. Hand-made for ROADMAP 2.3, sample data. Approved 2026-10-27 (agents their own addresses, a list page, summary on a button and not saved, tabs); ADR 0065 |
| `workflow-triggers.html` | Console: Skills → Automations with the 7 new triggers (deals, buyer match, appointments, past clients) in a "What can start a workflow" catalogue, sample workflows in words, and the assistant's approval card for one. Hand-made for ROADMAP 4.1, sample data. Approved 2026-10-28; ADR 0066 |
| `ai-decides.html` | Console: a workflow whose AI reads the enquiry and picks one of the person's options (Sell / Buy / Rent / Not sure), its runs with the choice and why, and the assistant's card. Hand-made for ROADMAP 4.2, sample data. Approved 2026-10-28; ADR 0067 |
| `twilio-setup.html` | Console: Connectors → Phone & SMS. The owner connects the agency's own Twilio (API key), sees Twilio's business check (reviewing / needs a fix / approved) and gets a number per agent; the agent's My phone: verify their mobile (Verified Caller ID), turn on Call Forwarding on No Answer, test call. `#agent` opens the agent's view. Hand-made for ROADMAP 3.1, sample data; carrier codes to be checked per carrier. Awaiting the client's approval (2026-10-29) |
| `missed-calls.html` | Console: the Missed calls page (Daily work; owner and agent views), one call's timeline (greeting → text → AI call back → CRM updated → agent alerted → text reply), the AI's summary citing the transcript, and the owner's settings (greeting, text template, AI call back with its bounds, calling hours, limits, who is told). `#call`, `#settings`, `#agent` open those screens. Hand-made for ROADMAP 3.2/3.3, sample data. Awaiting the client's approval (2026-10-29) |
| `sms-everywhere.html` | Console: Bulk SMS (template → people → Prepare → review with "Sent from" per person and why anyone is skipped → Approve & Send), an SMS template (channel on `email_template`, parts counter, STOP footer), "Text them" on a listing's Matching buyers tab, the pair skill "Workflow texts" with the new "Send SMS" step and "Missed call" trigger, and the agency number in Phone & SMS. Owner and agent views; `#rules` (the five rules to approve, opens first), `#bulk`, `#review`, `#templates`, `#buyers`, `#workflow`, `#settings`, `&agent`. Hand-made for ROADMAP 3.4, sample data. The user's decisions 2026-10-31 (channel column; agent's number else agency number; pair skill). Awaiting the client's approval |
| `control-centre.html` | Console: the Control Centre (Automation group) — today's counts, everything the automations did across workflows, skills, Phone & SMS and opportunities with each line's level and result, one event's full trail (trigger → what the AI understood → decided → did → who approved → result), what waits for approval, and the permission levels for every kind of step (a platform floor; the agency may raise, never lower). Owner and agent views; `#rules` (the four decisions, opens first), `#today`, `#event`, `#approvals`, `#levels`, `&agent`. Hand-made for ROADMAP 4.6/4.7, sample data. Awaiting the client's approval (2026-10-31) |
| `workflow-triggers-2.html` | Console: Skills → Automations → "What can start a workflow" with ROADMAP 4.4's twelve new triggers (contacts: a role, a brief, goes quiet, unsubscribes; leads: assigned, not contacted in N hours; listings: price changes, an open home finishes; email: a customer writes in; calendar: cancelled; deals: an offer comes in, N days before settlement), four that need something first, six example automations and the assistant's card. `#rules` (five decisions, opens first), `#catalogue`, `#examples`, `#card`. Hand-made for ROADMAP 4.4, sample data. Awaiting the client's approval (2026-10-31) |
| `ai-understands.html` | Console: ROADMAP 4.5 (A+B+C) — Leads with what the AI understood (type, urgency, a one-line summary; filters), one lead's panel with each figure shown beside the enquiry words it was found in, the approval card that saves the brief to the contact, workflows with the new conditions and step, and the skill (off until switched on). `#rules` (six details to settle, opens first), `#leads`, `#lead`, `#card`, `#workflow`, `#skill`, `&agent`. Hand-made for the USER's review (not the client), 2026-10-31 |
| `automation-library.html` | Console: the Automation Library on the Automations tab (owners and admins: 10 ready-made automations in groups, each with When / Then, what it needs, how many are on, Use this), the assistant with the library's words in the box, and an agent's tab without it. Hand-made for ROADMAP 4.3, sample data. Approved 2026-10-28; ADR 0068 |

## Where it came from

Google Stitch, project **"Remix of LocalAgentHub Agency Operating System"**,
id `11207375819501221556`, screen `8b6631d3f1a9414c8030c8d01c167baf`.

Stitch exposes an MCP server at `https://stitch.googleapis.com/mcp` and the key
lives in `.cursor/mcp.json`, which is gitignored. `get_screen` returns download
URLs for the HTML and the screenshot:

```sh
KEY=$(python3 -c "import json;print(json.load(open('.cursor/mcp.json'))['mcpServers']['stitch']['headers']['X-Goog-Api-Key'])")
curl -sS -X POST https://stitch.googleapis.com/mcp \
  -H "X-Goog-Api-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"get_screen",
        "arguments":{"name":"projects/<projectId>/screens/<screenId>"}}}'
```

The screenshot URL is an `lh3.googleusercontent.com` link and defaults to a
thumbnail. Append a size suffix — `=w1400` — or you get 135 × 512.

`list_screens` with `{"projectId": "<id>"}` lists the rest of the project.

## How it is used

The mock's own Tailwind config is in the `<script id="tailwind-config">` block
of the HTML, and it is the authority on the palette. `apps/web/app/tailwind.css`
reads its values into the `[data-skin='portal']` block, token by token, with the
mock's names in the comments so the two can be checked against each other.

**Structure is followed; data is not invented.** The mock carries a 24-photo
gallery, an energy rating, an inclusions schedule, a floorplan, CoreLogic
medians, a rental yield, days on market, school catchments and a mortgage
estimator. This platform has a source for none of them, and a plausible median
is the fabricated number non-negotiable #4 exists to forbid. Sections without a
source are named in one line rather than drawn — see `NotConnected` in
`apps/web/components/listing-sections.tsx`.
