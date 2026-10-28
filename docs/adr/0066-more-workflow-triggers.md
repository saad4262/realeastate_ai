# 0066 — More workflow triggers: deals, buyer matches, appointments, past clients

**Status:** accepted, 2026-10-28 (the user reviewed `docs/mocks/workflow-triggers.html` and chose: all four groups,
the deal's side chosen per workflow, the email rule unchanged). ROADMAP Phase 4.1. Migration 0069.

**Context.** The workflow engine (ADR 0041, 0048) had six triggers, all about leads, contacts, listings and a booked
appointment. The brief's #7 and #27 ask for follow-ups on deals, matches, inspections, appraisals and past clients —
all of which now have rows (ADR 0060, 0063).

**Decision.**
1. **Seven triggers**, in the one catalog (`workflows/catalog.ts`), each with only the settings it needs:
   `deal.stage_reached` (a stage; vendor or buyer), `deal.settled` (vendor or buyer), `buyer.matched`,
   `appointment.upcoming` (1–72 hours; a type), `appointment.completed` (a type), `appraisal.not_listed` (1–30 days),
   `sale.anniversary` (1–20 years). Each says which records a run has, so a step that needs a lead (none of them
   has one) is refused when the workflow is made, as before.
2. **The deal's side is the workflow's choice** (decision 2): every deal change makes one event per side, each
   carrying that side's contact. A side with nobody on the deal is a skipped run that says why.
3. **Told, or found.** `appointment.completed` is written by `completeAppointment` in its own transaction (the
   outbox of ADR 0041). The other six are found by `workflows/scans.ts`, run by the minute tick only while an
   active workflow wants one: from `deal_event` rows (the sync's moves, a person's, Settle), listings gone live
   against `briefFitsSql` (the Matching buyers tab's own rule), appointments starting within N hours (no later
   than two hours late, keyed on the start so a moved one counts anew and a cancelled one never), appraisals N
   days old with no listing since, and sales N years ago to the day on the agency's clock — the owners linked after
   the sale and the deal's buyer, never the vendor. Every event has a dedupe key, so a scan run every minute writes
   it once, and none reaches back before the oldest such workflow was made or more than a day or two.
4. **Scope** (D2) for a personal workflow: a deal is the agent's as its agent or on its listing; a buyer match when
   the buyer is assigned to them; an anniversary when the contact is theirs or the sale was.
5. **The rules do not change** (decision 3): an approved template goes by itself only if the person may receive it
   then; an email the AI writes always waits; 200 runs a day per workflow.
6. **Where it shows**: the assistant (prompt v29, the create_workflow tool's new fields) makes them; the Automations
   tab gains "What can start a workflow" — every trigger in groups with something to say to the assistant.
7. **Migration 0069** widens `workflow_event_kind_check` to the thirteen kinds; a test holds the catalog and the
   newest CHECK to the same list.

**Not done.** Missed calls (Phase 3); "AI understands → decides" (4.2); the Automation Library (4.3); a condition on
a deal's price or stage.
