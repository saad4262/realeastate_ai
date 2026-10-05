# 0021 — Skills: editable prompts over fixed, read-only handlers

**Status:** accepted, 2026-10-05. Migration 0025. CRM Phase 5 (first two skills).

**Context.** Agents want repeatable AI jobs — a morning brief, "which emails matter" —
that they can switch on, schedule, tune in their own words, and audit. The platform rules
still hold: AI only through packages/ai, every call metered, the LLM never produces a
number, nothing sent or changed silently.

**Decision.**
1. **Three tables.** `skill` — a library entry: name, description, the Markdown body
   (front-matter + instructions), the **handler** it runs, the integrations it
   `requires`, a model tier, a default schedule. `agency_id` null = platform library;
   set = that agency's own (admins curate). `agent_skill` — one agent's copy: their own
   edited body, on/off, schedule (daily/weekly/interval, time, IANA zone), next/last run,
   failure count, "email me the result". `skill_run` — one execution: trigger
   (schedule/manual), slot, status (running/succeeded/failed/skipped), summary + where it
   came from (model/template), the structured result, error, items processed. Cost is
   `ai_run` rows whose `entity_id` is the run's id.
2. **A skill is a prompt over a FIXED handler.** The Markdown is what the agent edits —
   tone, emphasis, what to lead with. What data is read, under whose permissions, and
   what the output may contain is the handler's code (`morning_brief`,
   `important_emails`). Editing the body cannot widen access or add an action. A new
   kind of skill is a new handler in code, reviewed.
3. **Front-matter** (`---` block): `requires: [google_calendar]`, `model: summary`,
   `schedule: daily 07:00`. The `requires` checked is the library skill's PLUS the copy's
   — an agent cannot edit a requirement away. A skill whose requirements
   `requireIntegrations` reports missing cannot be enabled or run ("Connect X first").
4. **Runs as the agent.** The handler reads through the same scoped functions the screens
   use, with the agent as the actor — a brief can never include a lead, email or
   appointment that agent could not open.
5. **Every AI claim cites its record.** The model is given records labelled `[A1]`,
   `[E2]`… and nothing else; each sentence it writes must cite at least one label that
   exists, and any number in it must appear verbatim in a record it cites (quoted, never
   computed — #4). Anything else is rejected and a template is used. Lists, times and
   counts on the result page come from SQL; the model's text is labelled as written by
   the assistant (#7 scope: it reaches only the person who ran it).
6. **Models by tier, via env** (`packages/ai/src/models.ts`): `summary` → Haiku 4.5
   (`ANTHROPIC_SKILL_SUMMARY_MODEL`), `agent` → Sonnet 5.5 (`ANTHROPIC_SKILL_AGENT_MODEL`),
   `hard` → Opus 5.5 (`ANTHROPIC_SKILL_HARD_MODEL`). Both first skills are `summary`.
   Prices for Sonnet 5.5 / Opus 5.5 added and costed. The daily caps
   (`AI_DAILY_BUDGET_USD`, `AI_DAILY_BUDGET_USD_PER_USER`) are checked before every run;
   over the cap the run is `skipped`, not failed, and no model is called.
7. **Scheduler**: the search-alert pattern — claim with `FOR UPDATE SKIP LOCKED`, the
   unique `(agent_skill_id, scheduled_for)` slot as idempotency, `nextRunFor` anchored
   on the claimed slot, three consecutive failures pause it. It runs in the existing cron
   tick (`/api/cron/alerts`). Disabled skills are never claimed. "Run now" needs the
   skill to be on.
8. **Nothing is sent or changed** by these skills except the agent's own result email,
   when they ticked it — transactional, to themselves.

**Cron on Vercel Pro:** every 5 minutes (`*/5 * * * *`) on `/api/cron/alerts`. Daily and
weekly skills then start within 5 minutes of their time; intervals are floored at 60 min.
Every minute is possible on Pro but buys nothing a person would notice.

**Alternatives.** Free-form prompts with tools (an edited prompt could reach anything the
tools reach). Model-written numbers with a reviewer (rule #4 forbids it). A separate cron
route (one more secret and schedule to keep in step).

**Not done.** Sending skills (ADR 0022, proposed); moving saved-search alerts onto this
table; an "agent" tier skill (none yet).
