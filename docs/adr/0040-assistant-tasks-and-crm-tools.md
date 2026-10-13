# 0040 — Assistant Phase 2: multi-step tasks, full CRM tools, lists for bulk email

**Status:** ACCEPTED, 2026-10-13 (the user: every recommendation, see "Decided"). Phase 2 of ADR 0039.

## Context

Since ADR 0039 Phase 1 the model is told how each card ended, so it can continue a task across
turns. But a task still lives only in the conversation: there is no plan the person approves
once, no step that waits for tomorrow, and a turn may propose at most 3 cards
(`ASSISTANT_LIMITS.proposalsPerTurn`). Requests like *"remind me tomorrow at 9, then email Ali
the brochure"* or *"close these 6 leads and archive their contacts"* need more.

What exists and is reused, not rebuilt (verified 2026-10-13):

- **Cards** (`core/src/assistant/actions.ts`): frozen args resolved from handles, a card built
  from the database, idempotency per tool call, `execute()` through each screen's own core
  function (which asks `can()` again), audit, expiry.
- **Delayed runs** (`approveProposedAction` with `runAt` → `scheduled`; `runScheduledActions`
  claims due rows `FOR UPDATE SKIP LOCKED` and runs them **as the approver as they are then**,
  every check repeated). Called every minute (`apps/web/app/api/cron/minute`). Today capped at
  48 h and behind `ASSISTANT_SCHEDULING=1`.
- **Notifications** (`notification` table, the bell, `dedupe_key`) — written today only by
  meeting reminders.
- **Core write functions** with no assistant tool yet: `updateLeadStatus`, `assignLead`
  (`leads/triage-lead.ts`), `createContact` (`contacts/write-contacts.ts`), `createListing`,
  `updateListing`, `setListingStatus` (`listings/*`), template batches on a saved filter
  (`template-email/batches.ts` `prepareBatch`).

## Decision

### 1. A task is a plan of cards, approved once

A **task** is an ordered list of up to **10 steps** the person approves on **one plan card**.
Each step is either an existing write tool (note, next action, appointment, email, assign,
consent, contact/lead/listing change…) or one of two new step kinds:

- **remind** — at a time, put a line on the person's bell (and, if they want, email it to
  **themselves**). Nothing reaches anyone else.
- **wait** — "until <time>" before the next step.

Tables (additive migration):

- `assistant_task` — agency, author, conversation, title, `status`
  (`proposed → active → done | failed | cancelled | expired`), created/updated.
- `assistant_task_step` — task, `seq`, `kind` (`action` | `remind` | `wait`), `run_at`
  (null = as soon as the previous step is done), the **`proposed_action` row it runs as**
  (for `action`), the reminder text (for `remind`), `status`
  (`blocked | scheduled | running | done | failed | skipped | cancelled`), result, error.

**Every action step IS a `proposed_action` row.** Planning resolves each step exactly as
proposing that tool does today (handles → ids, card text from the database, idempotency key per
step), so a step runs through the same `execute()` path, with the same re-checks, audit and
outcome as a single card. No second execution path exists.

### 2. Planning — the model writes the plan, the server makes it safe

A new write tool **`plan_task({ title, steps: [{ tool, input, at? }] })`**. Each step's `input`
is parsed by that tool's own zod schema and resolved by that tool's own propose function in a
"plan" mode that returns the frozen args and card **without storing a separate card**. Any
refusal (no permission, contact not visible, "Connect Zoom first", consent missing) refuses the
whole plan, naming the step — nothing half-made. The plan card lists every step in words, with
its time, and **the exact text of anything that reaches another person**.

### 3. Approve once; run step by step; stop on failure

- **Approve** the plan → task `active`; step 1 is `scheduled` (at its time, or now);
  the rest `blocked`.
- The **minute tick** runs due steps through `runScheduledActions` (extended to tasks): as
  the approver, as they are now; a step's `done` moves the next one to `scheduled`
  (at `max(its time, now)`).
- A step that **fails stops the task**: the rest are `cancelled`, the task `failed`, and the
  model is told in `<card_updates>` (task lines next to card lines) — so it can explain and
  offer a fix.
- **Cancel** the task any time: every step not yet run is cancelled. Offboarding (ADR 0030)
  cancels a removed member's tasks, as it cancels their cards today.
- Steps may run up to **30 days** after approval (the single-card 48 h cap stays for
  single cards). Task scheduling is on without `ASSISTANT_SCHEDULING`: the minute tick is real
  now (ADR 0035).

### 4. Checked after each step (verification)

After a step runs, a per-tool **read-back** confirms what the step says it made (the note
exists on that contact, the appointment is booked at that time, the lead's status is now
closed, the email row is `sent` or `sending`). A step whose read-back disagrees is `failed`
with "could not confirm the change" — never silently `done`.

### 5. CRM tools (decisions A and C of ADR 0039)

All are cards (or task steps) over existing core functions unless noted:

| Entity | Tools | Notes |
|---|---|---|
| Contacts | `create_contact` | Never consent by creation. "Delete" = `set_contact_archived` (exists). |
| Leads | `set_lead_status`, `assign_lead`, `create_lead` | "Delete" = status `closed`. `create_lead` needs a new core function (a lead an agent records by hand: source `manual`). **New lead → the listing's lead agent is assigned automatically** (ADR 0039 C3), in `createEnquiry` too. A reassigned agent keeps seeing it, read-only: the card refuses with "This lead is now with another agent. You can no longer change it — contact your agency for more information." |
| Agents | `invite_agent` | `update_agent` / `remove_agent` exist. Owners/admins only. |
| Listings | `find_listings`, `create_listing_draft`, `update_listing`, `withdraw_listing` | Publishing stays owner/admin (ADR 0014). Hard delete only for a draft, as `deleteListing` allows. |

### 6. Bulk email on lists

`send_template_email` also takes a **saved filter** (`contact_filter`, the directory's own)
instead of references, and batches above 20 up to the agency's configured limit. The card
shows the count, every skip with its reason, and the first recipients; consent and opt-out are
re-checked at send (ADR 0022, unchanged).

### 7. "Connect X first", everywhere

Every tool that needs an integration returns one shape —
`{ needs_connection: { provider, label, href } }` — and the panel shows a Connect button
beside the answer. A plan with such a step is refused at planning with that shape.

## Limits and safety

- Up to 10 steps per task, 30 days span, 5 active tasks per person (configurable).
- Only the author approves or cancels a task; owners/admins may cancel any task in their agency.
- Every step runs as the approver **at run time** — a lost permission fails that step.
- Anything model-written that reaches another person is shown word for word on the plan card
  (ADR 0025, non-negotiable #7's rule for the person's own messages).
- No step kind runs code, SQL, or anything not in the tool list.

## Tests

Unit: plan parsing refuses a bad step and names it; a plan of N steps makes N proposed_action
rows and one card; step state machine; read-back per tool. Smoke (rolled back): plan → approve
→ tick runs step 1 → step 2 waits for its time → done; a step whose permission is gone fails
and cancels the rest; cancel mid-way; two ticks never run a step twice; agency B never sees A's
tasks; auto-assignment on a new lead; the reassigned agent's refusal. Break-tests for: the
step claim, the stop-on-failure, the read-back, the permission re-check.

## Open questions (recommended first)

1. **An email to a contact inside a task:** *approve once on the plan card, with the exact text
   shown, consent re-checked when it sends* — or ask again on the day before sending?
2. **Longest task:** *30 days* — or longer?
3. **A reminder to yourself by email too:** *bell always, email if asked* — or bell only?
4. **Leads created by an agent by hand:** *assigned to that agent, source "manual"* — or left
   for the agency to assign?
5. **Bulk email limit:** keep today's *20 per batch, 50 per agent/day, 200 per agency/day*
   (env), or raise them (and to what)?

## Estimate

Task engine + plan card + reminders + read-back: 70–100 h. CRM tools (incl. auto-assignment
and the new `create_lead`): 40–60 h. Saved-filter bulk email: 10–15 h. Connection shape +
panel button: 6–10 h. **About 125–185 h**, each part with its smoke checks and break-tests.

## Decided (2026-10-13, the user)

1. An email to a contact inside a task is **approved once, as exact text on the plan card**;
   consent, opt-out and limits are checked automatically when it sends.
2. A task spans at most **30 days**.
3. A reminder always rings the **bell**; it is emailed (to the person themselves) only when asked.
4. A lead an agent records by hand is **assigned to that agent**, source **`manual`**.
5. Email limits **unchanged**: 20 per batch, 50 per agent per day, 200 per agency per day.

## As built — Phase 2, part 1 (2026-10-13, branch `feat/assistant-tasks`; migration 0047 applied — dev and production are one database)

- **Migration 0047:** `assistant_task` (RLS on, status CHECK); `lead.source` (`website` | `manual`,
  existing rows `website`); `proposed_action.task_id` / `task_seq` + index; status CHECK adds
  `blocked`; tool CHECK = `PROPOSED_ACTION_TOOLS` (every write tool but `create_reminder`, plus
  `remind`).
- **Tasks:** `plan-task.ts` `proposePlanTask` resolves each step through that tool's own path in
  plan mode (`ToolContext.plan`, collected by `propose()`); any refusal names the step and makes
  nothing. `task-state.ts`: `activateTask` (Approve), `advanceTask` (done → next released at
  `max(its time, now)`; failed → the rest cancelled, task failed with "Step n: reason"),
  `endTask` (plan rejected/cancelled/expired, `cancel_task`), `taskAllowsRun` (active, within
  30 days), `verifyExecuted` (the read-back, inside the step's savepoint). Steps run through
  `runScheduledActions` (now with a `taskId` filter; Approve runs the plan's due steps at once).
  Reminders: `notifyMyself` (bell, deduped per step) and `buildReminderEmail` to the person's own
  address only when asked (`mail_me`). Offboarding cancels `blocked` steps and the person's tasks.
- **CRM tools** (`crm-tools.ts`): `find_listings` (P references), `set_lead_status` (field
  `stage`), `assign_lead` (owners/admins), `create_lead` (→ `createManualLead`, assigned to the
  recorder, `source = manual`, own listings only), `create_contact`, `create_reminder` (a one-step
  plan), `cancel_task`. `lead:create` permission (+ test). `createEnquiry` assigns the listing's
  lead agent (`leadAgentIdSql`). `LEAD_NOW_WITH_ANOTHER` from `updateLeadStatus` and the card.
- **Found and fixed:** `activeMemberActor` (scheduled cards, task steps, imports) carried no
  `listingAgentOf`, so work run later judged "a lead on my listing" more narrowly than the screen
  ("That lead no longer exists"); it now loads them. The assistant route and its card actions
  use `loadListingActor`, as the leads and mail screens do.
- Prompt **`assistant@v15`**. Not yet (Phase 2, part 2): listing draft/edit/withdraw, invite agent,
  bulk email on a saved filter, the shared "connect X first" shape with a Connect button.
