# 0026 — Gmail send-only (CRM phase 3c)

**Status:** ACCEPTED, 2026-10-06. **Built** 2026-10-06 (Phase 6, migration 0034) — see "As built" at the end. Decisions at the end ("Decided").

**Context.** Agents want email to the people they work with to come *from them* — their own
Gmail address, sitting in their Gmail "Sent" folder — not from the platform address. ADR 0016
decided we never read anybody's mailbox (the restricted read scopes need a yearly security
assessment and would put private mail in our database). Sending is a different, smaller
permission: `gmail.send` lets us send as the person and nothing else — no reading, no
listing, no deleting. Everything else about a conversation stays as ADR 0016 built it.

## Decision

1. **Scope `https://www.googleapis.com/auth/gmail.send` only** (+ `openid email` for the
   account label, as Calendar). No read, modify, compose or metadata scope, ever. A new
   provider `gmail` in `integrations/providers.ts`, in the ONE Google app (ADR 0020),
   requested incrementally when Gmail is first connected; the token carries only its own
   scopes (no `include_granted_scopes`, as Calendar). Owner types: `user` and `agency`.
2. **Who the email comes from — resolved per message, server-side, in this order:**
   1. the sending person's own connected Gmail (`integration_account` provider `gmail`,
      owner_type `user`, status `connected`, scope present);
   2. else the agency's connected Gmail (owner_type `agency`, connected by an owner/admin —
      e.g. `sales@agency.com.au` on Google Workspace);
   3. else the platform sender (Resend, the address and display name we use today).

   `resolveSender(db, actor)` is one function, beside `requireIntegrations`, returning
   `{ via: 'gmail' | 'resend', accountId, fromAddress, label }`. The compose box, the
   invitation preview and every assistant card show the resolved "Sent from" line before
   anything is sent (so nobody is surprised which address the client sees).
3. **Reply-To stays the signed thread address** (`t+<thread>.<sig>@MAIL_INBOUND_DOMAIN`,
   ADR 0016). A client pressing Reply answers the console thread, whichever sender was used.
   The From is the Gmail address (Gmail refuses any From that is not the account or one of
   its verified send-as aliases, so we never set another).
4. **What may go through Gmail:** person-to-person conversation messages — a reply typed in
   the console, an appointment invitation — and, later, an assistant-proposed one-to-one
   email. **Bulk template email (ADR 0022) stays on the platform sender**: a marketing batch
   from a personal Gmail risks that person's account reputation, cannot carry our managed
   unsubscribe handling as reliably, and Gmail's own daily quotas are low (see 7). (Open
   question 1.)
5. **The pipeline is unchanged except the last step.** `recordOutbound` writes the
   `mail_message` row `queued` in a transaction exactly as today; `deliverOutbound` picks the
   transport AFTER the transaction (a network call never runs inside one): Gmail
   (`users.messages.send` with the RFC 822 message, base64url) or Resend. The dev allowlist
   (ADR 0025 Q6) is checked first, in the shared path, for both. The row records which:
   - `mail_message.sent_via` (`resend` | `gmail`), `mail_message.sender_account_id`
     (nullable → `integration_account`, `set null`), and the Gmail message id in the existing
     `provider_id`. Additive columns.
6. **The timeline does not care which sender was used.** The message is in OUR
   `mail_message`/`mail_thread` before it is sent, so it appears in the console thread, on the
   contact's Emails tab and timeline, with "Sent from your Gmail" / "Sent from the agency's
   Gmail" / "Sent from LocalAgentHub" as a small label. We do not read Gmail to find it —
   the only copy we rely on is the one we wrote.
7. **Sending limits.** Our own limits still apply first and unchanged (`EMAIL_LIMIT_*`,
   counted from `mail_message`, whatever the transport). Google's own Gmail quotas are higher
   than ours today (they differ for consumer Gmail and Workspace — check Google's current
   published numbers when building), and a quota/rate error from Gmail is recorded on the
   message as `failed` with "Gmail's sending limit was reached" and a **Retry** and a **Send
   from the platform address instead** button — never a silent switch of the From address in
   the middle of a conversation (open question 2).
8. **Token expiry.** As every Google token here (ADR 0020 §5): renew before expiry, once more
   on 401; `invalid_grant` → account `expired`. A message that hits an expired Gmail is
   `failed` with "Your Gmail connection expired — reconnect it, or send from the platform
   address", both as buttons. While the Google app is in Testing, tokens die after about
   7 days — the Integrations page already says "Expired — reconnect".
9. **Google verification.** `gmail.send` is a *sensitive* scope (not *restricted* — the
   reading scopes are): the app needs Google's OAuth verification (homepage, privacy policy,
   scope justification, a demo video of the consent and send flow) but not the third-party
   security assessment that restricted scopes require. Confirm the classification in Google's
   scope list at build time. Until verified: Testing mode, listed test users only. Same
   verification as Calendar's — do both in one submission (DEPLOY.md go-live list).

## Permissions (all through `can()`)

- `integration:manage` (exists): connect/disconnect your own Gmail; an agency Gmail only
  owner/admin. Read-only members connect nothing.
- `integration:use` (exists): the server sends through your own Gmail as you; through the
  agency Gmail for any active member — **which an admin can switch off** with an agency
  setting "Members may send from the agency Gmail" (open question 3).
- `mail:send` (exists, `lead:update`'s rule): unchanged — the transport never widens who may
  send on a thread.

## When Gmail is not connected

- **Console compose / invitation:** nothing blocks. The "Sent from" line says
  "LocalAgentHub (connect your Gmail to send as you@…)" with a Connect link.
- **The assistant:** never says "Connect Gmail first" for an ordinary email — the platform
  sender is a valid sender, and its card shows it. Only when the person explicitly asks to
  send *from their Gmail* and it is not connected does the tool answer "Connect Gmail first"
  with the link and propose nothing (ADR 0025 §3 rule, applied to an explicit request).
- **Expired / permission_missing:** treated as not connected for resolution — the card and
  compose box say so and fall to the next sender in the order, visibly.

## Failure cases

| Case | What happens |
|---|---|
| Gmail token expired between preview and send | Message `failed`: "Gmail connection expired"; Reconnect / Send from platform buttons. |
| Gmail 429 / quota | `failed` with the reason; Retry later, or Send from platform. A failed message stops counting toward our daily limits (they count `queued` + `sent` platform-composed messages only, `email/limits.ts`). |
| Person disconnects Gmail while a message is queued | Resolution happens at send: falls to agency Gmail or platform; the "Sent from" on the message shows what was actually used. |
| Contact replies to the From (agent's Gmail) instead of Reply-To | The reply lands in the agent's Gmail, not the console. Gmail honours Reply-To on Reply, so this needs the client to retype the address; we say so in the help text. (Open question 4.) |
| Agency Gmail's owner leaves the agency | Offboarding (ADR 0030) flags agency-level accounts connected by that person for an admin to reconnect. |
| DMARC | Mail sent through the Gmail API from the account's own address is signed by Google; nothing for us to do. Resend path unchanged. |
| Dev | `EMAIL_DEV_ALLOWLIST` applies before the transport is chosen; the stub provider gets a `gmail` stub that records instead of sending. |

## Tests to write (when built)

- Unit: `resolveSender` order (own → agency → platform; expired/permission_missing skipped);
  MIME built with From = the account, Reply-To = signed thread address, no Bcc/Cc injection
  from text; base64url encoding.
- Unit: the transport chooser never runs inside a transaction (a fake db that fails if
  `transaction` is open during `send`).
- Smoke (fake Gmail, rolled back): reply sent via own Gmail → row `sent_via = gmail`,
  `provider_id` set, on the contact's timeline; agency Gmail used when own missing; platform
  when neither; expired → failed with both buttons; 429 → failed, no fallback; dev allowlist
  refuses before Gmail is called; an agent cannot use another agent's Gmail (`integration:use`).
- Permission tests for the new agency setting.
- **Break-tests:** remove the allowlist check → red; resolve another user's account → red;
  silent fallback on 429 → red; Reply-To missing → red.
- Live (opt-in only, never in `pnpm test`/`smoke`): one real send to a test inbox.

## Open questions (recommended answer first)

1. **Template (bulk) email through Gmail?** — *No; platform sender only*, for reputation,
   unsubscribe handling and quotas. Revisit per agency later.
2. **Automatic fallback to the platform on a Gmail failure?** — *No; a visible button*, so the
   From never changes without the person choosing it.
3. **May agents send from the agency Gmail?** — *Yes by default, with an admin switch to turn
   it off.*
4. **Replies that go to the agent's Gmail instead of the console** — *Accept for v1 and
   document it*; revisit with the agent's own auto-forward rule to the agency address if it
   happens often.
5. **Which messages show "Sent from your Gmail" to the contact's website view?** — *Same
   label as the console*; the buyer sees who wrote it either way.
6. **Send-as aliases (e.g. a shared alias on a personal account)?** — *Not in v1*; From is the
   account's primary address only.

## Decided (2026-10-06)

- **Q3 (the user): yes.** The sender is the agent's own Gmail, else the agency's Gmail, else
  the platform sender — and the agency Gmail step has an **admin switch** ("Members may send
  from the agency Gmail") that turns it off for the agency.
- Q1, Q2, Q4, Q5, Q6: **accepted as recommended** (bulk stays on the platform sender; no
  automatic fallback, a visible button instead; replies to the agent's Gmail accepted and
  documented; same "Sent from" label everywhere; no send-as aliases in v1).

## As built (Phase 6, 2026-10-06)

Built against fakes. Real Google calls need the user's account: TEST-PLAN AA.

- **Provider `gmail`** (user or agency), scopes `gmail.send` + `openid email`, in the one
  Google app (same client id/secret as Calendar, same `googleAdapter`; no
  `include_granted_scopes`). Migration 0034 adds the enum value and **widens the owner-type
  CHECK** (DROP + ADD, comparing as text). This is not strictly "add a column": it changes no
  row, and every existing combination is allowed exactly as before. Flagged in the report, like
  0031.
- **`resolveSender(db, actor)`** (`packages/core/src/mail/sender.ts`) runs one statement:
  own Gmail → agency Gmail (when `gmail:send_as_agency` allows: owners/admins always, other
  writing members unless `agency.members_may_use_agency_gmail` is off) → platform. Only an
  account that is `connected`, has every scope, passes `integration:use` and has a plain email
  address counts. The admin switch is `gmail:configure_agency` (owner/admin), on Settings →
  Integrations.
- **What may go through Gmail:** a person's console reply (no kind) and an appointment
  invitation (`appointment_invitation`), written by a member who is still active. Bulk
  template email (it carries an unsubscribe URL) and the inbound relay (`channel = 'email'`)
  never do. `buildMime` refuses a marketing message outright.
- **`deliverOutbound`** picks the transport after the recording transaction. The dev
  allowlist runs first, unchanged, before either transport. It records `sent_via`,
  `sender_account_id` and the real `from_email`. A Gmail message id is stored as
  `gmail:<id>` (`provider_id` is unique across transports). Failures are `failed` with a
  sentence (expired → "reconnect it, or send from the platform address"; quota → "Gmail's
  sending limit was reached"). **No fallback:** the console shows **Send from the platform
  address instead**, which calls `retryFailedMessage(…, { platformOnly: true })`.
- **MIME** is built by us from the same `EmailMessage` the platform sends. Names and subjects
  have line breaks removed and non-ASCII encoded (RFC 2047). Addresses must be plain.
  Bodies are base64. There is no Cc/Bcc. In-Reply-To/References are passed only when they
  look like Message-IDs.
- **Gmail errors:** 401 → renew once (shared `withAccessToken`); 429 or 403 with
  `rateLimitExceeded`/`userRateLimitExceeded`/`dailyLimitExceeded`/`quotaExceeded` → quota;
  403 insufficient permission → "reconnect".
- **Screens:** the composer shows the "Sent from" line. A sent message shows "Sent from their
  Gmail / the agency's Gmail / LocalAgentHub". The assistant's `check_connections` knows
  `gmail` (answered through `resolveSender`, so it respects the switch). The template-email
  card says template email never goes from a Gmail. No new assistant tool.
- Dev: tokens issued by the stub provider send through a stub Gmail that records and never
  sends.
- Not built: send-as aliases (Q6); a Gmail path for bulk (Q1).
