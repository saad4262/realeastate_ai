# 0074 — SMS everywhere: templates by channel and the "missed call" trigger (Phase 3.4, part 1)

**Status:** part 1 accepted, 2026-10-31 (the user's three decisions); **part 2 awaiting the client's approval
of the five rules** in `docs/mocks/sms-everywhere.html`. Migration 0074 (additive, idempotent) APPLIED
2026-10-31 at the user's go, after a rolled-back dry run (twice in one transaction: clean).
ROADMAP 3.4.

**Context.** ROADMAP 3.4 texts people from four places: Bulk SMS, matched buyers, a workflow step and a
missed-call workflow. The user decided (2026-10-31): SMS templates live in `email_template` with a channel; a
text goes from the contact's assigned agent's Twilio number, else the agency number; the workflow step needs
the agency's AND the agent's switch. Five rules (agency number, consent, sending hours, one automatic text per
caller per 24 h, 100 texts per number per day) wait for the client. Part 1 builds only what none of them touch.

**Decision — part 1 (built).**
1. **`email_template.channel`**, `email` or `sms` (CHECK), default `email`. An SMS template's subject is `''`.
   One table, so a later channel (WhatsApp) is a new value, not a new table.
2. **No email path can send an SMS template.** `mayUseTemplate` and `usableTemplateSql` — the one rule every
   email send asks (Bulk email, matched buyers, the assistant, workflows) — take the channel and default to
   `email`; `listTemplates` lists one channel (email by default), so the email screens never show an SMS one.
3. **SMS template rules, pure** (`template-email/sms.ts`): the body is up to 480 characters with the same merge
   fields; the app adds `Reply STOP to opt out` to every text, and nobody can remove it; `smsParts` counts the
   SMS parts (160/153 for GSM-7, 70/67 otherwise) for the editor and the review. People write templates; the AI
   never does (non-negotiable 7).
4. **Trigger `call.missed`** (`workflow_event_kind_check` widened). `recordMissedCall` emits it in the same
   transaction as the call row (the outbox, ADR 0041), origin `system`, with the agent and whether the caller is
   a known contact. Option `caller`: `known` / `new` / any. A personal workflow acts on its owner's own missed
   calls. A "new" caller has no contact, so only steps that need none (remind, message colleagues) are allowed;
   the merge field `caller_phone` names the number. It runs today with the existing steps (remind, note, next
   action, email template); "Send SMS" arrives with part 2.

**Decision — part 2 (after the client approves the rules).** The step `send_template_sms` behind the pair skill
"Workflow texts"; Bulk SMS batches (template → people → Prepare → review → Approve & Send, 48 h, 20 a batch);
"Text them" on Matching buyers; the agency number; the five rules at prepare and again at send.

**Deploy order.** The code reads `channel` and writes `call.missed`, so **0074 must be applied before this code
reaches production** (as 0069 had to be). Done: 0074 was applied before `feat/sms-foundation` was merged.
