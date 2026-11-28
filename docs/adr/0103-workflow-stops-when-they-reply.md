# 0103 — A workflow stops when the person replies

**Status:** accepted, 2026-11-27 (the user: "Step 1, stop on reply"). Amends ADR 0041 Part B. Migration 0110 (one index).

**Context.** A workflow's steps run to the end whatever the person does: a buyer who answers the first email still gets the text two hours later. Follow Up Boss pauses an action plan when the lead replies; HubSpot has unenrollment criteria. Ours had neither.

**Decision.**
1. `spec.stop_on_reply`: absent or `true` = on, `false` = off. **On for every workflow, saved ones too** — the change only ever sends less, and to people who already answered. No stored spec is rewritten.
2. A reply is an inbound email on any of the run's contact's conversations (or its lead's), or an inbound text from that contact, in the same agency, after the run was made. A call is not a reply (missed calls are the only ones we see). An auto-reply counts: we cannot tell it apart.
3. Checked at each step, in `runScheduledActions`, inside the step's claim transaction, before it runs: one query. A reply cancels that step and every step after it; the task ends `cancelled` with "Stopped: they replied". Nothing is failed and nobody is alerted.
4. The run's contact and lead are the run's own (`workflow_run.contact_id`, `lead_id`). A run with neither is never stopped.
5. The card says what happens on a reply; the assistant may set `stop_on_reply: false` when the person asks. `find_workflows` shows it.
6. Migration 0110: `workflow_run(task_id)` index — the step looks up its run by task, and that column had none.

**Alternatives.** An event on each inbound message that cancels open runs (two write paths, mail and SMS webhooks, to keep in step; the per-step check needs neither). Pausing instead of cancelling (a paused run nobody resumes is a cancelled one with extra state).

**Consequences.** One more query per workflow step. A workflow whose later steps are internal (a note, a status) also stops on a reply; set it off for those.
