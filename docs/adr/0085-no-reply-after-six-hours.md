# 0085 — "No reply" can fire after 6 hours

**Status:** accepted, 2026-11-07 (the user's decisions). Amends the `lead.no_reply` row of ADR 0041. No migration.

**Context.** `lead.no_reply` took a wait of 1 to 14 days, chosen per workflow; the Automation Library's "Chase a buyer with no reply" asked for 2 days. There is no platform-wide setting. A buyer's enquiry needs an answer sooner than a day.

**Decision.**
1. The trigger takes `hours: 6` in place of `days`. Exactly one of the two (`specProblem`). No other number of hours.
2. "Chase a buyer with no reply" now asks for 6 hours. It is what the assistant sets up from now on.
3. Waits in days stay valid. **A workflow already saved keeps its own wait:** it belongs to the agency that set it, and nothing rewrites stored specs.
4. The scan keeps a wait-in-days dedupe key (`noreply:lead:message:2`), so a message already chased is not chased again. A 6-hour wait has its own (`…:6h`), so it never collides with a 6-day wait.
5. The look-back stays wait + 2 days: switching a workflow on does not flood it with old threads.

**Cost.** A call or a text does not count as an answer until someone moves the lead on from New, so that lead still gets its reminder. The wait is clock hours. An email at 11 pm reaches 6 hours at 5 am, and a reminder step runs then. A workflow that should wait for office hours adds its wait-for-a-time step, as it could before.

6. **A new enquiry counts, on the 6-hour wait only** (the user: the first enquiry must not be missed). An enquiry's words are in `lead.message`, and its conversation has no message until someone writes, so the scan used to pass over it. It now fires when the conversation has no message, the lead came from the website and it is still New. Its dedupe key is `…:enquiry:6h`.
7. **A wait in days does not get this** (the user: saved workflows are not to change). They still fire only on a buyer's later message.

**Not changed.** The Opportunities skill "Unanswered emails" is a separate scan and still means 48 hours.

**Alternatives.** Any number of hours (nobody asked; widening later is one line). Converting saved workflows (rewrites an agency's setting, and is a write on production).

**Where it lives.** `NO_REPLY_HOURS`, `specProblem`, `triggerInWords` in `workflows/catalog.ts`; `noReplyWait`, `scanNoReply`, `triggerMatches` in `workflows/engine.ts`; `specFrom` in `assistant/workflow-tools.ts`; the tool's words in `packages/ai/src/tools/assistant-tools.ts`.
