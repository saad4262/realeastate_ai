# 0035 — Writing a new email to a contact, team messages, and both through the assistant

**Status:** ACCEPTED, 2026-10-12 (asked by the user, Roman Urdu: "the agency and the agent should
be able to email each other properly, also by asking the assistant; agents and the agency should
be able to send a NEW email to a contact, not only reply, also through the assistant; and buyers
need a place where they receive these emails and reply properly"). Amends ADR 0016 (a
conversation may now start with OUR message), ADR 0025 (three tools) and ADR 0026 (one more kind
may leave through Gmail). Migration 0041.

**Context.** Today a conversation starts only when a contact writes (an enquiry, an offer, mail to
the agency address) or with an appointment invitation. There is no "New email", and members
have no way to write to each other in the app.

## Decision

1. **New email to a contact** (`mail_message.kind = 'direct_email'`). Permission `mail:compose`
   on the contact = `contact:update` (its assignee, or an owner/admin) by a member who may write
   — the same person who may answer that contact's mail (ADR 0018). Refused, with the reason:
   no email address, archived or merged, **unsubscribed** (a reply on an existing conversation
   is still allowed), the dev allowlist, today's sending limits (it counts, as an invitation
   does). Subject ≤ 200, plain-text body ≤ 20,000.
   It opens a conversation with no lead (contact set), is recorded queued, then sent after the
   transaction from own Gmail → agency Gmail → platform (ADR 0026). It carries the contact's
   unsubscribe link (footer + List-Unsubscribe; Spam Act — a one-to-one email from a business
   can still be commercial). Their reply lands in the same conversation. Timeline: `email_sent`.
2. **Buyers.** Nothing new is needed to SEE it: `/account/messages` already lists every
   conversation whose address the buyer proved (ADR 0016), and the email's "view on the
   website" link proves it. Added: a per-buyer **unread** mark (`mail_customer_read`), shown on
   their messages list (not on /account, which deliberately runs no count). Buyers still start
   a conversation by enquiring (unchanged).
3. **Team messages** — new tables `team_thread`, `team_thread_member`, `team_message`; never in
   `mail_thread`, so an internal message can never reach the buyer portal or the contact inbox.
   Any active member who may write (not read-only) writes to 1–10 other active members of THEIR
   agency. Only the people on a
   conversation read it — not admins (as assistant conversations, ADR 0025). A removed member
   loses access; their messages stay for the others.
   Each message is also **emailed** to the other people on it (platform sender, Reply-To a signed
   `m+<thread>.<sig>@` address) and rings the console bell. A reply from a mail client is
   accepted only from an active member on that conversation whose mail passed DMARC; anything
   else is dropped, never stored.
4. **The assistant.** Read tool `find_colleagues` (everyone; `M` references, never ids). Write
   tools, cards only: `send_email` (one contact, subject, body) and `message_colleagues` (1–10
   `M` references, subject, body). The card shows the exact text and every figure in it under
   "Check these figures"; nothing is sent until the person approves THAT text (non-negotiable 7:
   model-written text reaching a third party needs a human). Every check repeats at run, now or
   scheduled. Prompt `assistant@v11`.

## Not done / questions for the client
- Editing the card's text before Approve (ask the assistant to change it instead).
- Attachments; a buyer starting a new conversation from the website without an enquiry.
- Read-only members read team messages sent to them but cannot write (the 2026-10-05 rule: they write nothing). Ask the client if they should.

## As built (2026-10-12, branch `feat/compose-email`, not committed)
- Core: `mail/compose.ts` (loadComposeTarget, previewContactEmail, recordContactEmail,
  sendContactEmail); `deliverOutbound` adds the opt-out link for `direct_email` and fails it
  without `ALERT_UNSUBSCRIBE_SECRET`; `team-messages/` (list, get, start, reply, mark read,
  deliver = bell + email, `ingestTeamReply`); `m+` addresses in `mail/address.ts`, routed by
  inbound, the webhook and the pull sync; buyer read marks in `mail/customer.ts`. Permissions
  `mail:compose`, `team_message:read|send`; contact view `mayEmail`. Activity `email_sent`.
- Assistant: `find_colleagues`, `send_email`, `message_colleagues`; card `figures`; run re-checks
  everything, delivery after the commit; prompt `assistant@v11`.
- Console: `/inbox/new`, `/my-inbox/new` (picker + form), New email on the inbox and the contact's
  Emails tab; `/messages`, `/my-messages` with nav badges; card figures and result links.
  Website: New pill on `/account/messages`, marked read on open.
- Migration 0041 written, NOT applied (the user's decision, 2026-10-12). The 0040 snapshot was
  replaced with 0039's (as the 0040 notes asked) so 0041 holds only this work.
- Tests: 11 unit (5 guards broken and seen red); 4 smoke checks written, NOT run (need 0041).

## Amendment — instant delivery (2026-10-12)
Asked: replies must reach the app the moment they arrive, and timed email must leave on time.
- **Inbound by webhook.** Resend `email.received` → `POST /api/mail/inbound` on the website
  (signed, Svix; the handler existed since ADR 0016). `RESEND_WEBHOOK_SECRET` set on the Vercel
  projects. The pull (cron and open inbox) stays as the backstop for a missed delivery — once a
  minute instead of every 10 s when the webhook is configured. Duplicates are harmless
  (`provider_id` unique).
- **Open screens refresh themselves.** The inbox used to refresh only when its OWN pull stored
  mail, which a webhook makes never happen. `LiveRefresh` (both console shells) asks every 5 s
  while the tab is visible for a stamp — newest activity on the conversations the person may see
  (the inbox's scope), the team conversations they are on, and their bell — and refreshes when it
  changes. The buyer's messages page does the same with `customerMailStamp`. No browser table
  access (ADR 0017): a server action returns a stamp, never data.
- **Timed sends every minute.** `/api/cron/minute` (`* * * * *`, Vercel Pro) runs assistant
  actions approved for later and meeting reminders — at most a minute late instead of five. The
  rest stays on the 5-minute tick. Sending "now" was always immediate.
- Not done: to-the-second scheduling (needs a queue such as QStash); push instead of a 5-second
  poll (needs a realtime channel through the server).
