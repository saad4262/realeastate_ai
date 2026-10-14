# 0041 — Assistant Phase 4: skills from plain language, and a workflow engine

**Status:** ACCEPTED, 2026-10-14 (the user; the "Open" defaults stand until changed). Phase 4 of ADR 0039
(its dashboards part is ADR 0036, built). Three decisions are the user's (2026-10-14), recorded
under "Decided"; the rest are proposed defaults, marked as such.

## Context

Two things people ask the assistant for that it cannot do yet:

1. **Skills** — "send me a brief every morning at 7", "turn off the email digest". Skills exist
   (ADR 0021: `morning_brief`, `important_emails`, `template_email`; an agent's own copy with a
   schedule, on/off and "email me"), but only from the Skills screen.
2. **Workflows** — "whenever a new enquiry comes in on a Parramatta listing, give it to Ahmed and
   remind me the next day". Nothing reacts to events today; tasks (ADR 0040) run a plan once, at
   times the person chose.

Rules that hold (CLAUDE.md, ADRs 0021, 0022, 0025, 0039, 0040): the server is the only door; every
change through the screen's own core function as a person, `can()` asked again; no LLM outside
`packages/ai`, metered; the LLM never produces a number; nothing model-written reaches a third party
without a human; consent and opt-out are checked when email is sent; no model-written code or SQL —
specs from a fixed catalog (ADR 0036's pattern).

## Decided (2026-10-14, the user)

- **D1 — Email in workflows (option C).** A workflow may send an agency **approved template**
  (ADR 0022) by itself, with every usual check (consent, opt-out, archive, the 7-day rule, daily
  limits, the dev allowlist) at the moment of sending. Any email the AI **writes** at run time is
  saved as a **draft** that the agent approves with one click; it is never sent by the workflow.
- **D2 — Who (option A).** An agent may make workflows that act only on **their own** leads and
  contacts (assigned to them, or on their listings). An owner or admin may make **agency-wide**
  workflows.
- **D3 — Order.** Step 1 skills by the assistant (quick win); then Step 2 the workflow engine and
  Step 3 its assistant tools and screen.

## Decision

### Part A — Skills by the assistant (Step 1)

Tools over the existing skills code (`packages/core/src/skills/skills.ts`), nothing new underneath:

| Tool | Kind | What |
|---|---|---|
| `find_skills` | read | The library (platform + agency) and the person's own copies, with schedule and on/off, as `Q` references. |
| `set_up_skill` | card | Add a library skill to "mine" if needed, set its schedule (daily / weekly / every N hours, a time, the person's zone) and "email me", and switch it on. |
| `change_skill` | card | Change one of mine: schedule, "email me", on/off, or its instructions (the exact new text on the card, before → after). |

- A skill whose requirements are not connected is refused with "Connect X first" (ADR 0040 part 2's
  shape and button).
- The handler never changes (ADR 0021 §2): instructions shape tone and emphasis, never access.
- A skill reaches only the person who owns it, so no extra approval beyond the card;
  its output keeps its "Written by the assistant" label.
- `template_email` stays manual-only (it is a send), as today.
- Removing a skill is `change_skill` off. "Delete" archives the copy, as the screen does.

### Part B — The workflow engine (Step 2)

**A workflow = WHEN (one trigger) + IF (0–5 conditions, all must hold) + THEN (1–6 actions in
order).** Each part is chosen from the catalog below. A workflow is a JSON **spec**, validated by
zod. The AI never writes code or SQL.

#### Triggers (v1)

| Trigger | Fires when | Its record |
|---|---|---|
| `lead.created` | An enquiry arrives from the website, or a lead is recorded by hand | the lead (and its contact, listing) |
| `lead.status_changed` | A lead moves to a status (`to`: new / contacted / qualified / closed) | the lead |
| `lead.no_reply` | A lead's conversation has the buyer's message last, unanswered for N days (1–14) | the lead |
| `appointment.booked` | An appointment with a contact is booked (`type` optional) | the appointment, its contact |
| `listing.status_changed` | A listing moves to live / under offer / sold / withdrawn | the listing |
| `contact.created` | A contact is added (`source` optional: manual / enquiry / import) | the contact |

Later (not v1): time-based workflows ("every Monday 9am") — that is a skill or a reminder today.

#### Conditions (v1)

Fields from the trigger's record:
- `listing.suburb`, `listing.channel` (sale / rent);
- `lead.kind` (enquiry / inspection / appraisal), `lead.source` (website / manual);
- `assignee` (a member, `M` reference);
- `contact.role` (buyer / seller / landlord / tenant / investor);
- `appointment.type`.

Operators: `eq` / `in` / `not_in`, the values from fixed lists where a field has one.
Each condition is checked in SQL against the record as it is **when the workflow runs**.

#### Actions (v1)

| Action | What | Runs by itself? |
|---|---|---|
| `add_note` | A note on the contact; text fixed when the workflow is made, with merge fields | yes |
| `set_next_action` | Next action text, due in N days | yes |
| `remind_owner` | Bell (and the owner's own email if asked), after N hours/days | yes |
| `set_lead_status` | Move the lead to a status | yes |
| `assign_lead` / `assign_contact` | Give it to a member — **agency-wide workflows only** (owner/admin) | yes |
| `message_colleagues` | A team message, text fixed when the workflow is made | yes |
| `send_template_email` | An **approved template** to the contact — D1 | yes, with every check at send |
| `draft_email` | The AI writes an email from the workflow's instructions and the record's facts → a **draft** for the owner to approve — D1 | **no — waits for one click** |
| `wait` | Wait N hours/days (up to 30) before the next action | — |

- **Merge fields** (`{{contact_first_name}}`, `{{listing_address}}`, `{{agent_name}}`) are filled from
  the database when the action runs, never by the model. Fixed texts are approved by the person when
  they approve the workflow — the same as a template they wrote.
- **`draft_email`:** one metered call through `packages/ai`, given only facts the run read from the
  record and the workflow's instructions. Every figure is listed on the draft, as `send_email` does
  (ADR 0035 §4). The draft is a `proposed_action` (`send_email`, conversation empty, origin `workflow`).
  The owner sees it in **Waiting for you** (the bell, and a list on the workflows screen). Approve sends
  through `recordContactEmail` with every check; drafts expire after 7 days (proposed).

#### Who and how it runs

- **Scope (D2):**
  - An agent's workflow matches only events whose record they may act on: the lead or contact is
    assigned to them, or the lead is on their listing. Asked by `can()` when the run starts, not
    trusted from the event.
  - An agency-wide workflow (owner/admin) matches every event of the agency.
  - Assigning is agency-wide only.
- **As whom:** every action runs as the workflow's **owner, as they are at run time**, through the
  same core function a screen uses. A lost permission fails that run with the reason.
  An owner who is removed (ADR 0030) has their workflows **paused**. An agency-wide workflow whose
  owner leaves needs an admin to take it over.
- **Events (transactional outbox):** the core functions that make each trigger's change write one
  `workflow_event` row in the **same transaction** (`createEnquiry`, `createManualLead`,
  `updateLeadStatus`, `scheduleAppointment`, `setListingStatus`, `createContact`). The row holds
  kind, agency, record ids and origin — no text. A rolled-back change emits nothing. `lead.no_reply` is found by
  a scan in the minute tick (one statement), once per thread per workflow.
- **Matching and running:**
  - The minute tick claims events (`FOR UPDATE SKIP LOCKED`), finds the agency's active workflows
    for that trigger (one statement), and checks scope and conditions.
  - For each match it makes **one run**, unique per (workflow, event), so an event is never run twice.
  - A run is an ADR 0040 task: each action a `proposed_action` step, already decided by the owner
    (they approved the workflow), run by `runScheduledActions` — the same claim, re-checks, savepoint,
    read-back and audit as a card.
  - `wait` is a step's run time. `draft_email` creates the draft and the run goes on.
  - The step that sends an approved template uses the ADR 0040 part 2 list-part path (classified
    again at send).
- **No loops:** an event caused by a workflow's own action (origin `workflow`) never triggers a
  workflow in v1.
- **Limits (proposed):**
  - 10 active workflows per agent, 50 per agency.
  - 200 runs per workflow per day; over that, events are skipped and the owner is told once.
  - The agency's email limits apply to template sends as always.
  - A kill switch: an admin can pause every workflow of the agency.
- **Audit:** each run is listed on the workflow (when, what record, each action's outcome and reason).
  Each change made on a contact's timeline says "by workflow «name»". Run history is kept 90 days
  (proposed).

#### Data (additive migration)

- `workflow`:
  - agency, owner, scope (`mine` | `agency`), name, `spec` (jsonb: trigger, conditions, actions);
  - status (`active` | `paused` | `archived`), version, created/updated;
  - the `proposed_action` that approved it.
- `workflow_event`: agency, kind, record ids, origin, occurred_at, claimed_at, processed_at.
  Purged after 30 days.
- `workflow_run`: workflow, event, status, task id, error, created; **unique (workflow_id, event_id)**.
- `proposed_action.origin` (`assistant` | `workflow`).
- The tool CHECK adds the new tools.

### Part C — Making and managing workflows (Step 3)

- **Assistant:**
  - `propose_workflow({ name, scope, trigger, conditions, actions })` → a card that reads the whole
    workflow in plain words, e.g. "When a new enquiry arrives on a listing in Parramatta → give it to
    Ahmed → remind you the next day".
  - The card shows every fixed text word for word, every template by name, and which actions run by
    themselves and which wait for approval.
  - References only (`M`, `T`, `P`); values from the catalog's lists.
  - Approve → active.
  - `find_workflows` (read), `change_workflow` (pause / resume / rename / archive) as cards.
  - Editing a workflow's spec is a new `propose_workflow` that replaces it on approval (version + 1).
- **Screen:** Workflows (agency and agent consoles):
  - the list with on/off and runs today;
  - one workflow's plain-words view and its run log;
  - **Waiting for you** (drafts);
  - pause all (admins).
  The same words the card uses.
- **"Delete"** archives (ADR 0039 A).

## Safety, restated

- Nothing reaches a contact unreviewed except an admin-approved template, with consent, opt-out and
  limits checked at send (D1).
- Nothing an agent makes can touch another agent's leads (D2).
- Everything runs as a person, through the screens' functions, `can()` asked again.
- No code, no SQL, no number from the model.
- Every run and every change is recorded.

## Tests (each part with its break-test)

- **Unit:** the catalog and spec schemas (an unknown trigger/field/action refused, naming it);
  scope (an agent workflow never matches another agent's lead); merge-field rendering; loop guard;
  plain-words rendering of a spec.
- **Smoke (rolled back):**
  - an event in the same transaction as its change (rolled back → no event);
  - one run per (workflow, event) under two ticks;
  - an agent workflow ignores a colleague's lead;
  - a template step skips an unsubscribed contact;
  - `draft_email` waits and sends only on Approve;
  - a removed owner's workflow pauses;
  - another agency never sees or triggers it.
- **TEST-PLAN AP.**

## Estimate

| Step | Work | Hours |
|---|---|---|
| 1 | Skills | 10–15 |
| 2 | Engine: events, matching, runs, actions, draft email, limits | 40–55 |
| 3 | Assistant tools and screen | 20–25 |
| 4 | Tests and docs | ~10 |

**About 85–110 hours.**

## Open (proposed defaults — confirm or change)

1. Limits: 10 workflows per agent, 50 per agency, 200 runs per workflow per day.
2. AI drafts expire after 7 days unapproved.
3. Run history kept 90 days; events 30 days.
4. v1 has no time-based trigger (use a skill or a reminder) and no workflow-to-workflow chains.
