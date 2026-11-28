# 0106 — Workflows of up to 12 steps, and stopping a run in flight

**Status:** accepted, 2026-11-27 (the user, after the 12-step audit). Amends ADR 0041 (limits) and ADR 0088's top-bar Stop. No migration.

**Context.** A workflow held 6 steps, waits included, so "assign → notify → status → email → 2 h → text → 1 day → call task → email → 3 days → …" could not be one workflow. And once a run had started, nothing stopped it but a reply (ADR 0103): pausing only stopped new runs, `stopAssistantTask` refused a workflow's task on purpose ("pause the workflow instead"), and the panel had no Stop for a workflow.

**Decision.**
1. `WORKFLOW_LIMITS.actions` = 12, for the steps and for each AI choice. The model's input, the tool description and the prompt (`assistant@v32`) follow it. The existing rule stays: all waits together under 29 days, as a run's task lives 30.
2. `stopWorkflowRun(runId)`: the rest of one run is cancelled, its task ends `cancelled` "Stopped by hand…". `stopWorkflowRuns(workflowId)`: every run of it in flight, in one transaction, two statements. Both need `workflow:manage` on the workflow — its owner, or an owner/admin — the rule for pausing it, not the task rule (a run's task belongs to the workflow's owner, so an admin could not stop an agent's run under the task rule).
3. Automations panel: each run in flight has Stop (`canStop` per run, same rule). Server action `stopWorkflowRunAction`.
4. Chat: `change_workflow` takes `stop` — pause it AND stop every run in flight; the card says how many. `pause` keeps its meaning (nothing new runs). Overview, Email and SMS chats all have it, as they have `change_workflow`.
5. A step already running when Stop lands finishes; nothing after it runs.

**Not changed.** `stopAssistantTask` still refuses a workflow's task: a run is stopped through its workflow's rule.

## Part 3 (2026-11-28, the user: "lead ka naam aur har step ka exact waqt dikhna bohot zaroori hai")

The panel beside a chat (and on Skills → Automations) showed each run as a time and a count. Now, still no migration:
1. **Who.** Each run names the person it is for — the name its steps' cards were made with (`card.contact.name`, written by the engine at run time). No new read, and nothing a reader of the run could not already see in its steps.
2. **When.** Each step carries its time: a done/failed one when it finished, the next one when it is due (`run_at`). A step not yet released has no time yet — it depends on the one before — so it says so in words ("2 h after the step before", "…, inside its hours"); no guessed clock time. A skipped step never shows the time it would have gone. The run's line says "Next: <step> · <time>"; "Each step" opens the list.
3. **Which.** A workflow paused, stopped or resumed in a chat shows in that chat's panel as itself, live, wherever it was made — when the person may see it (their automations list decides). Its change card then goes. A workflow only *asked about* (`find_workflows`) is not pinned: one question can list them all.

**Found in the browser run (2026-11-28, Playwright on dev, live model; TEST-PLAN DB/DC/DD all passed after these):**
- A run's step titles named nothing: the engine called `actionInWords` without names ("Send the template “template”", "a team member") and left merge fields raw ("Call {{contact_name}}"). Now `namesFor` once per run, and `renderMerge` on the title.
- A stopped run read "Started": the panel showed `workflow_run.status`, which never moves on. Now running/done/stopped/failed from its steps.
- A skipped step showed a time when a reply stopped it, none when stopped by hand. Now never; the run's line says why, once.
- The side panel covered the composer's Send and the cards' right edge on 1200–1600 px screens: the CSS kept room for `aside[aria-label='This chat’s automations']`, a label renamed on 2026-11-23. Now matched by `data-chat-side`.
- The Email chat listed its email templates when the model asked for SMS ones, unlabelled, so it took "Welcome" for an SMS template. `list_templates` now says which channel it listed, and that the asked one is not shown.
- Skills → Automations showed "1 today" beside "Not run yet": a workflow's `lastAt` was always null; it is now its latest run's time.
- The stop/pause card said "1 run is going now: they carry on"; now "it".
