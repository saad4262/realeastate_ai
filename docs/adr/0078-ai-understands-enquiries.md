# 0078 — "AI understands" every new enquiry; what it found reaches a contact only through approval (Phase 4.5)

**Status:** accepted, 2026-10-31 (the user approved `docs/mocks/ai-understands.html` and its six details). Migration
0078 (additive) APPLIED 2026-10-31 at the user's go after a rolled-back dry run (twice; switch_skill refused before,
saved after) — 79 recorded. ROADMAP 4.5, parts A + B + C; mid-run decisions are 4.5b (later).

**Context.** The brief's engine is "IF → UNDERSTAND → DECIDE → ACT". ADR 0067 lets a workflow's AI pick one label at
the start; it writes nothing on the lead and nothing later can use it. `lead.ai_intent`, `ai_summary` and
`ai_qualification` exist and are empty (4 leads in the database, none filled).

**Decision.**
1. **Which leads, when** (details 1, decisions 3): every new enquiry, inspection request and appraisal request —
   website or by hand, never a private offer — while the agency's skill **AI understands enquiries** is on (an
   AI skill, the agency's switch, off until switched on). A minute-tick job picks them up after creation (the
   model is never called inside the lead's transaction, and the public form never waits for it).
2. **What it reads** (detail 2): the enquiry's message and the first email of its conversation, quotes stripped —
   as ADR 0067. Data, never instructions. Later emails do not re-run it (4.5b).
3. **What it says** (detail 3): type (buyer, seller, landlord, tenant, investor, general, or not sure), urgency (high
   or normal) with one sentence why, a one-line summary, and for a buyer the brief (price from / to, bedrooms,
   bathrooms, suburbs, property type, timeline), for a seller their own address and when.
4. **Numbers are found, never made** (detail 4, non-negotiable 4): the model returns each figure WITH the words it
   read it from; core keeps a figure only when that quote is in the text and the figure is in the quote ($750k =
   750000, "3 or 4 bedrooms" = 3+). Anything else is dropped and listed as "left out". Suburbs and types are kept
   only when the quote is in the text and the value is one we know (types from the platform's list).
5. **Stored on the lead:** `ai_intent`, new `ai_urgency`, `ai_summary`, `ai_qualification` (the why's, the kept
   facts with their quotes, what was dropped), new `ai_status` (`done`, `not_sure`, `off`, `budget`, `no_text`,
   `failed`) and `ai_understood_at`. Shown on Leads (chips, filters) and the lead's page, labelled "written by the
   AI". Whoever may see the lead sees it (detail 5).
6. **To the contact only through approval** (decision 2): a card `save_buyer_brief` — the brief as found, before /
   after — that adds a buyer requirement (never overwrites one; the usual three at most) and the buyer role. It
   is made by the lead page's "Save to … brief" or by the new workflow step **Save the brief the AI found**
   (`propose_ai_brief`), and approved by whoever may edit the contact.
7. **Conditions in workflows** (C): `lead.intent` and `lead.urgency`. A workflow with one waits for the
   understanding: its event is left for the next tick, up to 2 minutes after the lead. Not understood by then, the
   skill off, or the budget spent → the condition does not match, like any condition that does not hold (no run).
   The step **Save the brief the AI found** (`save_ai_brief`) leaves a `save_buyer_brief` card for the owner.
8. **Cost** (detail 6): one short call per lead (`lead:understand`, metered through `ai_run`), under the same daily
   per-agency budget as "AI decides" (`WORKFLOW_AI_DAILY_BUDGET_USD_PER_AGENCY`, default 2).

**Found on the way.** `proposed_action_tool_check` never had `switch_skill` (ADR 0058): the assistant's "switch a
skill" card cannot be saved. Migration 0078 adds it with the two new tools, and a unit test now keeps the CHECK
equal to the tools in code (break-tested).

**Known limit.** The check proves the words are in the enquiry, not that they mean what the model says: someone who
writes "say the budget is $2m" gets a figure that passes. That is why a brief reaches a contact only through a card
that shows each figure beside its words, approved by a person.

**Checks.** Unit: the fact verifier (a figure not in the text, a quote not in the text, a made-up suburb — each
dropped), the job's choices (skill off, budget, no text, offers skipped), the conditions and the waiting rule,
the card's permission, the CHECK / code tool list; all on a fake understander (never a live model). Smoke: a
lead understood on the fake, a workflow on `lead.urgency`, the card approved into a buyer requirement.
