# 0068 — The Automation Library

**Status:** accepted, 2026-10-28 (the user reviewed `docs/mocks/automation-library.html`; decisions: inside the
Automations tab, set up through the assistant, owners and admins only). ROADMAP Phase 4.3. No migration.

**Context.** Workflows are made by asking the assistant (ADR 0041). An agency that does not know what to ask gets
nothing; the brief's #27 asks for ready-made automations to start from.

**Decision.**
1. **Ten ready-made automations** in `packages/core/src/workflows/library.ts`, pure data, in four groups (Leads,
   Appointments, Deals, Buyers and past clients): reply to website enquiries in office hours; sort enquiries
   (AI decides, ADR 0067); chase a buyer with no reply; the inspection reminder the day before; a follow-up after an
   inspection; an appraisal not listed after a week; the buyer's checklist at Contract; thank the vendor and ask for
   a review at settlement; just listed for matching buyers; a home anniversary.
2. **Words, never a spec.** An entry is the card's words and the words typed into the assistant's box. "Use this"
   opens the assistant with them (`/overview?ask=…`, ADR 0054's path) — **typed, not sent** (decision 2); the
   assistant asks what it needs (which template, who), builds the workflow with `create_workflow`, shows the card,
   and nothing starts until it is approved. So an entry can never do what the assistant and `checkWorkflow` refuse,
   and a new trigger or rule reaches the library for free.
3. **Inside the Automations tab, for owners and admins** (decisions 1 and 3): at the top of `/skills?tab=automations`,
   filtered by group in the URL (`lib=`), and only where `workflow:create_agency` holds. Every entry is agency-wide.
   An agent's tab has no library; they still make their own by asking.
4. **"N like this on"**: the agency's active workflows on the same trigger, with or without a decision — a hint,
   not a lock (the same entry may be set up twice, for two templates).

**Not done.** The library's own versions or edits per agency; one-click setup without the assistant; templates that
write the email templates themselves; agents' library.
