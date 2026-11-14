# ADR 0091 — The Control Centre: one place for everything the automations did

**Status:** accepted for parts A–C, 2026-11-14 (the user: "chlo banna start karo"). Parts D–F wait on the
client's four decisions in `docs/mocks/control-centre.html`.

## Context
ROADMAP 4.6/4.7: an agency must see what ran by itself, open any line for its full trail, and act on what
waits for a person. The rows already exist in five tables: `workflow_run` (+ its task's steps),
`automation_run`, `skill_run`, `phone_call` (missed), `opportunity`. Nothing new needs recording for A–C.

## Decision
- **A. Activity:** one read in `packages/core/src/control-centre/` unions the five sources into one feed
  (time, what, source, level, result, whose) with six tiles counted in SQL. Last 24 hours / 7 / 30 days,
  not "today": the agency has no stored time zone, and a guessed one is wrong for Perth.
- **B. One event's trail:** trigger → AI decision → each step → who approved → result, from the same rows.
- **C. Waiting for approval:** `proposed_action` rows a workflow made that still wait (`status = 'proposed'`).
- **Who sees what (client decision 1) is already the rule** of the top-bar panel, so it is reused:
  `automation_status:read` (your own) and `automation_status:read_all` (owners and admins, the agency's).
- Migration 0097 adds three indexes (additive) so the agency-wide reads do not scan.

## Not in this ADR
D (permission levels and their floors), E (12-month record), F (failure bell and 8 am email): the client's
decisions 2–4. A–C show a step's level as it is today (approval for an AI-written draft or brief, automatic
otherwise) and change nothing about how anything runs.

## Consequences
Read-only: this page cannot cause a send. A workflow run's trigger is gone after 30 days (events are purged),
so an older trail starts at the run; runs themselves go at 90 days until decision 3.
