# 0074 — SMS everywhere: templates by channel and the "missed call" trigger (Phase 3.4, part 1)

**Status:** part 1 accepted, 2026-10-31 (the user's three decisions); part 2 built 2026-11-02 on the user's
answers to the five rules in `docs/mocks/sms-everywhere.html` (below; the client's approval still open). Migration 0074 (additive, idempotent) APPLIED
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

**Decision — part 2 (the user's answers on the five rules, 2026-11-02; the client has not answered).**
1. **From which number:** the contact's assigned agent's active number, else the **agency number**: one of the
   agency's existing numbers the owner picks in Missed calls → Settings (`missed_call_setting.agency_number_id`;
   unset = the owner's own). Neither → skipped "No number to send from". Numbers arrive with Twilio; until then
   everything runs on the stub.
2. **Who may get a marketing text:** the Bulk email rule, unchanged (`hasMarketingConsentSql`: recorded, or an
   enquiry in 24 months, or a client), the email unsubscribe tested first; plus an Australian mobile and nobody
   who replied STOP to the agency. The user asked for "everyone once the skill is on"; kept as proposed because
   the Spam Act 2003 needs consent (express or inferred) and a working opt-out for every commercial text, and the
   fine falls on the agency. The rule is one function (`smsSkipReason`); the client may change it after legal
   advice. STOP and the footer are not settings.
3. **Sending hours 9 am–8 pm**, the agency's time zone (`sms_hours`, the owner may change them): Bulk SMS,
   matched buyers and workflow texts. Approved outside them, a batch waits (`approved_sending`, recipients
   `queued`) and the minute tick sends it at 9. The instant missed-call text is not held.
4. **At most 3 automatic texts per caller in 24 hours** (`auto_texts_per_caller_day`, default 3; the mock said 1):
   missed-call texts and workflow texts to one number, counted together across the agency's numbers. Bulk and
   matched-buyer texts are a person's choice and are not counted here.
5. **100 texts per number per day** (`texts_per_number_day`), every kind counted together. Past it: skipped
   "daily limit reached". 20 people a batch, as Bulk email.

**Built (part 2).** Migration 0079 (additive, idempotent; APPLIED 2026-11-02 by the user after a rolled-back dry run
run twice; smoke "SMS everywhere (ADR 0074)" 1/1 green): `email_batch.channel` (email | sms; every email path
asks for `email`, so an SMS batch is never sent as email), `email_batch_recipient.phone / phone_number_id /
sms_message_id`, the four settings above on `missed_call_setting`, and `send_template_sms` in
`proposed_action_tool_check`. Core `template-email/sms-batches.ts`: prepare (classify, freeze the number and the
from-number), approve (once, as Bulk email), send (claim one recipient at a time, every rule again, hours, the
same sms_message row on a retry), resume in the minute tick. The step `send_template_sms` behind the pair skill
`workflow_texts` (the agency's switch AND the sending agent's). Console: Bulk SMS (`/bulk-sms`, `/my-bulk-sms`),
the SMS template editor, "Text them" on Matching buyers, the texts section of Missed calls → Settings.

**Deploy order.** The code reads `channel` and writes `call.missed`, so **0074 must be applied before this code
reaches production** (as 0069 had to be). Done: 0074 was applied before `feat/sms-foundation` was merged.
