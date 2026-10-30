# 0071 — Missed calls: kept, greeted, texted behind a two-switch skill; the Missed calls page (Phase 3.2)

**Status:** accepted, 2026-10-30 (the client approved `missed-calls.html` and the Skills structure, ADR
0069). Migration 0072 (additive, idempotent, NOT applied). ROADMAP 3.2.

**Context.** ADR 0070 forwards an agent's missed calls to their Twilio number and keeps them. The brief
(#28) wants the caller texted at once, and the client wants every automation behind a Skills switch.

**Decision.**
1. **A skill, `missed_call_text`** (group Phone & SMS, needs Twilio, runs by itself), the first `pair`
   skill: it runs for an agent only when the agency's switch AND the agent's own are on; an owner or
   admin's switch is the agency's. `isPairedSkillOn` (pure rule `pairedSkillOn`) for machine paths; an
   agent's Skills card says whether the agency has it on.
2. **On a missed call** (`recordMissedCall`, from the voice webhook): the call is kept with an `outcome`
   — `texted`, or the first reason it was not: `skill_off`, `private`, `not_mobile` (landlines can't take
   texts), `opted_out` (STOP), `repeat` (texted that caller today), `limit` (per agent / per agency a day),
   `text_failed`. The decision is a pure function. The text is written queued inside the transaction and
   sent to Twilio after it (never inside); a retried webhook rolls back and sends nothing.
3. **The text is the owner's template**, three fields filled (`{{first_name}}` or "there",
   `{{agent_first_name}}`, `{{agency_name}}`); any other field is refused on save. No model writes it
   (non-negotiable 7). Defaults in core; `missed_call_setting` holds an agency's own (greeting, text,
   texts per agent and per agency a day). The caller hears the owner's greeting only when a text follows;
   otherwise a fixed one that promises nothing.
4. **The agent is told** on their bell ("Missed call from …", with the text or the reason), linking to
   the call. **Daily work → Missed calls**: the last 7 days (an agent's own; owners/admins every agent's),
   counts of rows (missed, texted, replied, not handled), a filter, one call's timeline (call, greeting,
   text and its delivery, replies, handled), Call / Open the texts / Open contact / Mark as handled
   (`missed_call:handle`: the agent, or owners and admins). Settings tab for owners and admins.

**Not done.** The AI call back, priority and calling hours (3.3, Retell); email to the agent; a follow-up
text; giving a missed call to another agent.
