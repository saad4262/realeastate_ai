# 0105 — Workflows of up to 12 steps, and stopping a run in flight

**Status:** accepted, 2026-11-27 (the user, after the 12-step audit). Amends ADR 0041 (limits) and ADR 0088's top-bar Stop. No migration.

**Context.** A workflow held 6 steps, waits included, so "assign → notify → status → email → 2 h → text → 1 day → call task → email → 3 days → …" could not be one workflow. And once a run had started, nothing stopped it but a reply (ADR 0103): pausing only stopped new runs, `stopAssistantTask` refused a workflow's task on purpose ("pause the workflow instead"), and the panel had no Stop for a workflow.

**Decision.**
1. `WORKFLOW_LIMITS.actions` = 12, for the steps and for each AI choice. The model's input, the tool description and the prompt (`assistant@v32`) follow it. The existing rule stays: all waits together under 29 days, as a run's task lives 30.
2. `stopWorkflowRun(runId)`: the rest of one run is cancelled, its task ends `cancelled` "Stopped by hand…". `stopWorkflowRuns(workflowId)`: every run of it in flight, in one transaction, two statements. Both need `workflow:manage` on the workflow — its owner, or an owner/admin — the rule for pausing it, not the task rule (a run's task belongs to the workflow's owner, so an admin could not stop an agent's run under the task rule).
3. Automations panel: each run in flight has Stop (`canStop` per run, same rule). Server action `stopWorkflowRunAction`.
4. Chat: `change_workflow` takes `stop` — pause it AND stop every run in flight; the card says how many. `pause` keeps its meaning (nothing new runs). Overview, Email and SMS chats all have it, as they have `change_workflow`.
5. A step already running when Stop lands finishes; nothing after it runs.

**Not changed.** `stopAssistantTask` still refuses a workflow's task: a run is stopped through its workflow's rule.
