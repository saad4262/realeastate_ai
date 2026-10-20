# 0048 — Workflows: name, listing and radius filters; send at a time; templates by the assistant

**Status:** ACCEPTED, 2026-10-20 (the user, Roman Urdu: "the owner tells the assistant: when new leads come —
only from certain suburbs, names, agents, a distance — email them; it asks for the template and the time;
then every new lead gets it automatically; these are saved and can be turned on and off").
Extends ADR 0041 (workflows) and ADR 0043 (templates). No new engine, no new screen.

## Context

ADR 0041's workflows already do most of it: trigger `lead.created`, conditions (suburb, channel, kind,
source, assignee, contact role), `send_template_email` with consent checked at send, `wait` N hours,
pause / turn on / archive on the Workflows screen and by `change_workflow`. Three gaps:

1. Filters: no contact name, no specific listing, no distance.
2. Time: only "N hours later" — not "at 9 am" or "only in office hours".
3. Templates: the assistant can only list them; a new one means leaving the chat for Bulk email.

## Decision

**A. Conditions** (catalog, checked against the record as it is at run time, like the rest):
- `contact.name` — `eq` / `in` / `not_in` (the whole name) and new `contains` / `not_contains`
  (any of the words appears), case-insensitive. `contains` ops are for this field only.
- `listing` — specific listings, as P references from `find_listings` → ids, checked to be the agency's.
- `listing.near` — `within` N km (0.1–100) of a place. The model gives the place's NAME; the server
  geocodes it (`resolvePlace`: cache → Google → our own suburbs) when the card is made, and the card shows
  where it was found. Coordinates are stored in the spec; the model never writes a coordinate (#4).
  A listing without a pin never matches (said on the card).

**B. `wait_until`** — an action like `wait`: `from` (HH:mm), optional `to` (HH:mm), optional `days`
(mon…sun; default every day), on the **agency's** clock (`agency.time_zone`, frozen into the run):
- with `to`: go on at once inside the window, else at the next window's start;
- without `to`: the next `from` on an allowed day.
It applies to the next step's due time (`stepDueAt`, after any `gapHours`). It must be followed by a
real step (not last, not followed by `wait` / `wait_until`); a `wait` may come before it. All waits
plus 7 days per `wait_until` must stay under 29 days (a run's task lives 30). DST through
`instantForLocalTime`.

**C. `create_template`** — a new write tool (a card): name, subject and body with the template merge
fields (`{{first_name}}` …). The card shows the exact words and every figure in them, labelled
"Written by the assistant"; Approve saves it through `createTemplate` (ADR 0043: an owner's/admin's is
the agency's, an agent's is their own; `email_template:draft` asked again). The person approves the
exact text, so model-written words reach a third party only after a human (AGENTS.md #7). Then the
assistant uses it in `create_workflow` (list_templates → T reference). Not a plan step.

## Alternatives

- One card making the template and the workflow together: fewer clicks, but a spec naming a template
  that does not exist yet breaks `checkWorkflow`'s rule; two cards keep both checks whole.
- A radius by coordinates the model gives: refused (#4).
- Overnight windows (22:00–06:00): not in v1.

## Consequences

- Migration **0056**: the `proposed_action` tool CHECK adds `create_template` (no row change).
  Specs are jsonb — no migration for A or B. Old specs stay valid.
- Prompt `assistant@v24`. The Workflows screen shows the new parts through the same words.
- Unit: catalog rules, conditions, the window (DST, weekdays), specFrom, the tool definitions.

## As built (2026-10-20, branch `feat/workflow-filters`; migration 0056 APPLIED 2026-10-20)

- Catalog (`workflows/catalog.ts`): `contact.name`, `listing`, `listing.near` (a union member with
  `km` + `place`), ops `contains` / `not_contains`, action `wait_until`; rules and words.
- Engine: facts carry the listing's pin; `conditionsHold` (haversine), `stepsFor(…, timeZone)` puts a
  `window` on the next step; the agency's zone is read only for a workflow with a `wait_until`.
- `workflows/send-window.ts` (`windowFrom`, `readWindow`, `nextInWindow`); `stepDueAt` applies it.
- Assistant: `specFrom(ctx, input, places)` + `nearPlaces`; `proposeCreateWorkflow` geocodes first
  (`resolvePlace`); model fields `time` / `until` — never `to` (nothing reads as a recipient; the
  red-team test caught it). `assistant/template-tools.ts`: `create_template` card → `createTemplate`.
- Prompt `assistant@v24`. TEST-PLAN **BB**.
