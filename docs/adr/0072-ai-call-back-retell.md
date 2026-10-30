# 0072 — The AI call back: Retell, scheduled in calling hours, behind a two-switch skill (Phase 3.3)

**Status:** accepted, 2026-10-30 (the client approved the mocks and the bounds; the user: build 3.3 with
placeholder keys). Migration 0073 (additive, idempotent, NOT applied). ROADMAP 3.3.

**Context.** A missed caller is kept and may be texted (ADR 0071). The brief (#28, #9) wants the AI to
call them back, qualify, and leave a summary for the agent. Non-negotiable 7 says model-written words that
reach a third party need a human; this is the one exception the client agreed, with bounds.

**Decision.**
1. **One platform Retell agent** for every agency (`RETELL_API_KEY`, `RETELL_AGENT_ID`). Its prompt is
   `packages/ai/src/prompts/ai-callback-v1.ts` (non-negotiable 3), sent to Retell by `retell:setup`; per
   call only three dynamic variables (agent's and caller's first names, agency name).
2. **The bounds, in the prompt and in the product:** off until both the agency's and the agent's
   "AI calls back" switches are on (a `pair` skill, ADR 0069 §4); it says it is an AI assistant and that
   the call may be recorded; it only asks what the call is about and offers a call back from the agent;
   never prices, valuations, advice or promises; books nothing; under four minutes; once per caller a
   day; never a STOP number; only people who just called; daily ceilings per agent and agency.
3. **Scheduled, never called from the webhook.** `recordMissedCall` sets `ai_status = scheduled` and
   `ai_due_at` = N minutes later (1/2/5/10), moved into the agency's calling hours (default Mon–Fri
   8–8, Sat 9–5, Sun none, agency time zone). The minute tick claims due calls with one guarded update
   and checks again before each: handled → skipped; the caller texted back → skipped; skill now off,
   STOP, number gone → skipped. Otherwise Retell places it from the agent's Twilio number.
4. **Calling from the agent's number:** "Set up AI calls" (owners) makes one Elastic SIP trunk with a
   credential list on the agency's Twilio (the password encrypted, AAD `<id>:sip_password`) and imports
   each number into Retell with that trunk. Numbers are NOT moved onto the trunk, so their incoming
   calls still reach our voice webhook. Showing the agent's own mobile as caller ID: not yet (to test).
5. **Retell's webhook** `/api/phone/retell/<token>`: the token (HMAC from INTEGRATION_TOKEN_KEY) always;
   Retell's `x-retell-signature` when `RETELL_VERIFY_SIGNATURE=1`; only a call id we placed whose
   metadata carries our own id. `call_ended`: outcome, duration, transcript, https recording URL.
   `call_analyzed` (once): summary and priority (a label — high/medium/low), a note on the contact
   headed "written by the AI from the call; check it before you act", the agent's bell, and Retell's
   cost metered in `ai_run` (`ai_callback`, `retell`).
6. **The page:** the Missed calls list shows the AI's part (when it will call, spoke to them · priority,
   no answer, or why not); a call's page shows the summary labelled as the AI's, the transcript and the
   recording. Settings: after how long, calling hours, AI calls per agent / agency a day.

**PROVISIONAL until tried with real keys:** Retell request shapes, the signature format (hence off by
default), the SIP trunk calls, and AU caller-ID on outbound SIP. **Not done:** the agent's mobile as caller
ID; creating a contact or lead for an unknown caller; a second attempt after no answer; live call coaching.
