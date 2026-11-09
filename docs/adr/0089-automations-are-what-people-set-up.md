# 0089 — Skills are what we provide; automations are what people set up with them

**Status:** accepted, 2026-11-09 (the user). Migration 0095 (two new tables). Amends ADR 0022 §2 and ADR 0088's panels.

**Context.** A skill is a facility the platform provides: a recipe. An automation, a task and a schedule are one thing to the person:
what they get done for themselves, to their own requirement, through a skill's chat. One skill can make many automations, each with its
own chat and history, running side by side. Nothing today runs a bulk send on a clock: workflows run on events, and ADR 0022 said
"no scheduled sending".

**Decision.**
1. **One word on screen, Automation.** Skills → Automations lists all of it, from where each already lives: workflows, one-off tasks,
   scheduled AI skills, and the new repeating ones. They differ only in when they run. Nothing is migrated.
2. **New: a repeating automation** made in a skill's chat. `automation` holds what it does, the skill it came from, its chat, its
   schedule and status; `automation_run` is one run: its people, how far it has got, and why it stopped. One engine; each skill plugs in
   a kind: its spec, its runner, its description in words. Bulk email first.
3. **ADR 0022 §2 changes.** A person may approve a repeating bulk email once, on a card showing the template, the list and the schedule. The model writes
   nothing at run time: the template is the approved one. Every run checks consent, unsubscribes, archive and limits again, through the
   send path Bulk email already uses. Limits stay as they are: a run that reaches one stops and says so.
4. **The scheduler is the skills' (ADR 0021 §7):** claim with `FOR UPDATE SKIP LOCKED`, a unique slot per automation, the next run anchored on
   the slot. A run's people are frozen when it starts and sent in batches across ticks, so a long run survives a function timeout.
5. **It stops itself** when its skill is off (that run is skipped and says why), its owner has left, or it has failed three times.
6. **The top bar.** Skills: each skill opens to its automations and chats. Automations: only what is running or just ran, with progress.

**Alternatives.** A time trigger on workflows (a workflow acts on one record per event; this acts on a list per clock). Moving workflows and
tasks into one table (a migration of running work, for no gain on screen).

**Consequences.** `create_automation` stores its card as `create_workflow`, as `create_reminder` stores `plan_task`, so the database's card CHECK does not change.
