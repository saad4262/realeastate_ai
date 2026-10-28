# 0067 — "AI decides" at the start of a workflow

**Status:** accepted, 2026-10-28 (the user reviewed `docs/mocks/ai-decides.html` and chose the four recommended
answers). ROADMAP Phase 4.2. Migration 0069 (shared with ADR 0066): `workflow_run.decision`.

**Context.** A workflow (ADR 0041) runs the same steps for every event. The brief's "AI understands → decides" step
asks for a workflow that treats a seller's enquiry differently from a buyer's. `lead.ai_intent` exists and nothing
writes it.

**Decision.**
1. **One decision, at the start** (decision 1): a spec may carry `decide` — the person's question and 2 to 4
   choices, each a label and its own 1–6 steps. The workflow's own steps are **"Not sure"** (decision 3): what runs
   when the AI is not sure, or is not asked. So a workflow never stalls.
2. **What the AI reads** (decision 2): the enquiry's message and the newest email from the client on its
   conversation (quotes stripped), or for `appointment.completed` its outcome note. Nothing else — not notes, not
   other records. Only the triggers with words: a new lead, a lead's status change, no reply, an appointment
   completed. The text is data, never instructions (the prompt says so; core enforces the rest).
3. **The AI only picks a label.** packages/ai's `WorkflowDecider` (one short call, metered as `workflow:decide`)
   answers a label or null and one sentence why; core keeps the answer only if it is one of the workflow's labels
   (case and spacing aside) — anything else is "Not sure". It never writes a step or sends anything; every step
   still runs through the engine and the screens' code, with the email rules unchanged.
4. **Steps run by themselves; the log says why** (decision 4): `workflow_run.decision` holds `{ choice, reason,
   by }` and the run's page shows "AI chose Sell — …". When the AI is not asked, `by` says why: the new platform
   skill **AI decisions in workflows** is off (ADR 0058, the owner's switch), there was nothing to read, the budget
   (`WORKFLOW_AI_DAILY_BUDGET_USD_PER_AGENCY`, default 2, under `AI_DAILY_BUDGET_USD`) is spent, the server has no
   AI (`WORKFLOW_AI=off` or no key), or the call failed — each runs "Not sure".
5. **Checked like any step list.** Each choice's steps meet the same rules as the workflow's own (a record its
   trigger has, assigning only agency-wide, no wait at the end), named by their label; labels are distinct and
   never "Not sure".
6. **Made by asking.** The assistant (prompt v30, `create_workflow.decide`) builds it; its card shows the question,
   each choice and "Not sure".

**Not done.** A decision in the middle of a run or more than one per workflow (decision 1); writing
`lead.ai_intent`; conditions on the AI's choice in a later workflow; the Automation Library (4.3).
