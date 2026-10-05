# 0016 — Email conversations live in the app, and Gmail stays in step

**Status:** accepted, 2026-10-03.

**Context.** The client wants agencies to read and send email inside the console and
buyers to read theirs on the website, without either having to leave for Gmail —
while Gmail keeps working for anyone who prefers it. Until now nothing recorded an
email we sent, and nothing could receive one.

**Decision.**
1. **The platform owns the conversation; Gmail is a window onto it.** No OAuth into
   anybody's mailbox. Reading a Gmail inbox needs Google's restricted scope, a yearly
   third-party security assessment, and puts every agent's private mail in our
   database. Instead every email we send carries a signed Reply-To
   (`t+<threadId>.<hmac>@MAIL_INBOUND_DOMAIN`); a reply from any client lands back in
   the same thread through Resend Inbound.
2. **`mail_thread` + `mail_message`.** One thread per lead, made by a database trigger
   on `lead` insert (and backfilled), so the two existing lead write paths are not
   touched. Status and assignee stay on `lead` — one source of truth. A thread with no
   lead is mail sent straight to the agency's own address (`<slug>@MAIL_INBOUND_DOMAIN`).
3. **Permissions mirror leads.** `mail:read` is `lead:read`'s rule and `mail:send` is
   `lead:update`'s; an offer's thread also needs `lead:read_offer`. A thread with no
   lead is owner/admin only. A buyer reads with `mail:read_own` and sees only what
   was sent to them or by them. Matching is on `user.verified_email` — an address
   the account PROVED by opening a link sent to it — never the sign-in email alone:
   sign-up does not confirm addresses here, so anybody could register as somebody
   else and read their agency mail. Until proved, only leads the account itself made
   (a signed-in private offer) show.
4. **Agent replies from Gmail are relayed.** A notice to an agent carries the same
   Reply-To. When the inbound sender is an active member allowed to send on the
   thread *and* DMARC passed, the quoted history is cut and the reply is sent on to
   the buyer from the platform address. Anything else is stored as received.
5. **Inbound HTML is never inserted into our page.** It renders in an
   `<iframe sandbox>` with no scripts, no same-origin and a CSP that blocks every
   remote fetch (no tracking pixels).
6. With `MAIL_INBOUND_DOMAIN` unset, sending still works and the Reply-To is the
   agent's own address — the old behaviour — and the console says so.

7. **Pulled as well as pushed** (2026-10-03, later). Received mail is listed
   from Resend (`GET /emails/receiving`) whenever an inbox or messages page is
   open and on every cron tick, and fetched only when addressed to one of our
   addresses. The webhook is now an optimisation, not a requirement — inbound
   works on localhost and with Resend's managed `<id>.resend.app` domain.
8. **The buyer replies on the website too** (`channel: 'website'`), and every
   agency reply carries "View this conversation on the website": a link whose
   token proves the mailbox, so opening it signed in with that address is the
   verification. Agency emails carry the whole lead — offer amount, property
   features, ad, last sale, message — to people can() lets see it.

**Not done.** Attachments are listed but not stored or sent; no per-user signature;
no rich-text composer; no realtime push to an open page (it polls every 20 s).
