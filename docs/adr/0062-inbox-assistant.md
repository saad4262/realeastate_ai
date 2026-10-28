# 0062 — The inbox assistant: a summary and a reply draft, on a button

**Status:** accepted, 2026-10-27 (the user reviewed `docs/mocks/inbox-ai-reply.html`: the summary only on a
button; three tones). ROADMAP Phase 1.6. No migration.

**Context.** The brief's #1: the AI summarises a conversation and drafts replies. Inbound email itself was
built in ADR 0016 and only needs its domain, MX record and two env values (DEPLOY.md); the missing part was
the assistant in the conversation.

**Decision.**
1. **Over the reply box, on a conversation the person may reply to**, two buttons: "Summarise this
   conversation" and "Draft a reply" (Friendly · Short · Formal, plus an optional line of what to say).
   Neither runs by itself — each press is one metered model call (`inbox:summary`, `inbox:draft`).
2. **Core numbers the conversation** as the cards appear (the form message first; an empty one kept, so
   "message 3" is the third card), the newest 12 at most, quoted history stripped. The model sees only
   this conversation — no CRM, no other mail.
3. **Core checks every answer** (#4): a summary point is kept only if it cites a message that exists and
   every figure in it is in a message it cites; at most five. A draft's figures that the conversation and
   the agent's own line don't contain become "[check this figure]"; the prompt also asks for [brackets]
   wherever a fact is missing. Messages are data: the prompts say so, and the checks hold whatever a
   message says.
4. **Nothing is sent by it.** The draft goes into the reply box under an amber note; the agent edits it and
   presses Send (the existing send, checks and all). It never replaces typed words without asking.
5. **Gated** by the "AI email drafts" switch (ADR 0058) — off, the panel says so and offers nothing — by
   `INBOX_AI` (off) and a missing key, and by a trailing-24-hour budget per agency
   (`INBOX_AI_DAILY_BUDGET_USD_PER_AGENCY`, default $2) under the global `AI_DAILY_BUDGET_USD`.
6. The model calls live in `packages/ai/pipelines/reply-assist.ts` (#3) behind `ThreadSummarizer` and
   `ReplyDrafter` in core; prompt `reply-assist@v1`, the skills' agent tier.

**Not done.** A summary on the conversation list; drafting a first email (the assistant's send_email does);
SMS replies (Phase 3); turning inbound mail on (configuration, DEPLOY.md).
