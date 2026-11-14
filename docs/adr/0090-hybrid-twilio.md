# 0090 — Hybrid Twilio: the agency's own account, or a subaccount the platform manages

**Status:** proposed, 2026-11-14 (the user chose the hybrid). Amends ADR 0070 §1–2 and ADR 0087 §1.
Migration 0096 (additive, NOT applied: `.env.local` is production). Built in phases (below).

**Context.** ADR 0070 asks every agency to open Twilio, add a card, pass Australian KYC in Twilio's
console and paste an API key. Agencies that already run Twilio, with numbers and history, can do that
and want to. Most cannot, and stop at sign-up. The user wants both: connect your own, or let us run it.

**Decision.**
1. **Two kinds of account.** `phone_account.kind`: `byo` (connected with the holder's own key, today's
   only kind) or `managed` (a subaccount the platform made under its own Twilio). For a managed account
   `account_sid` IS the subaccount SID; no second column that could disagree with it. A member's own
   account (ADR 0087) is always `byo` (CHECK). Every call about a number still goes through
   `numberTwilio` → that account's key, so missed calls, texts, Bulk SMS, AI calls, the five SMS rules
   and the skill switches do not change.
2. **BYO.** The holder does three things by hand: a paid Twilio account, the AU regulatory bundle in
   Twilio's console, and an API key pasted here (Account SID, key SID, secret). The app does the rest:
   checks the key, reads the bundle hourly, and now also **lists the numbers already on the agency's
   account** so an owner gives one to an agent instead of always buying (ADR 0087 gave this only to
   an agent's own account). Before pointing an existing number here, the only fields we change — its
   two URLs and their methods — are saved in `phone_number.previous_webhooks` (our own URLs from an
   earlier use here are not kept) and put back when it is released, stopped or disconnected here. A
   number the agency had before is never given back to Twilio on release. A number answered by a SIP
   trunk, a TwiML App, or a Messaging Service that does not defer to the number's webhook is refused
   with what to change in Twilio, never half taken over. A leaving member's own number is not put back:
   its key is forgotten inside `removeMember`'s transaction, where no Twilio call may run.
3. **Managed.** The master credential is a **Main API key** of the platform's Twilio (a Standard key
   cannot create subaccounts; Main keys are made only in Twilio's console), in env only
   (`TWILIO_MASTER_ACCOUNT_SID`, `TWILIO_MASTER_API_KEY_SID`, `TWILIO_MASTER_API_KEY_SECRET`), never in
   the database. When an owner turns Phone on (not at sign-up: empty subaccounts count toward Twilio's
   1,000 default), the app creates the subaccount, then a Standard key inside it, stored encrypted like
   a BYO key. A leaked key is one agency; the master key never leaves the server's env.
4. **KYC.** BYO: read from Twilio, as today. Managed (phase 3): the agency fills a form here (business
   name, ABN, AU address and proof, authorised person and ID); the app creates the end-user, documents
   and bundle in the subaccount and submits. The bundle is always **the agency's business**, never ours.
5. **Test mode, while there is no ABN.** `PHONE_MANAGED_TEST_MODE=1`, refused unless
   `PHONE_TEST_COUNTRY_CODES` includes `1`: a managed account is marked `approved` with **no bundle** and
   the note "Test mode: not checked by Twilio", and its numbers are bought as **US (+1) local** numbers.
   An Australian number still requires a real `bundle_sid` (the existing check in `getNumberForAgent`),
   so a mock approval can never buy one. Remove both variables from Vercel before the first real agency.
   US texting caveat: texts between US numbers need A2P 10DLC registration; calls and texts to +92 are
   what the test exercises.
6. **Billing (phase 4, not built; the user sets prices and limits later).** BYO: Twilio bills the agency.
   Managed: Twilio bills our master; each subaccount's usage is read nightly (Usage Records) into our
   table and reported to Stripe metered billing. Retell AI calls are the platform's cost on **both**
   kinds and metered on both. Protection: a card before Phone turns on, a monthly spend cap, a mid-month
   charge past a threshold, suspend the subaccount after a failed payment's grace.

**Phases.** 1: `kind`, BYO existing numbers, previous webhooks. 2: managed subaccount and key, test-mode
KYC, US numbers. 3: the in-app KYC form and bundle API, with a pilot agency's real ABN. 4: Stripe,
usage, caps. 5: office line (ADR 0087 part 2), porting, history import.

**Alternatives.** BYO only (ADR 0070): onboarding stops for most agencies. Managed only: agencies with
working Twilio numbers and history would have to port or abandon them.

**Consequences.** We hold a Main key that can create and suspend subaccounts: env only, rotated on any
leak. Twilio bills us before Stripe bills agencies, so managed carries credit risk until phase 4. Still to
confirm with Twilio in writing: AU mobile bundles per subaccount for an ISV, the Scams Prevention
Framework changes to AU KYC, moving a number between accounts.
