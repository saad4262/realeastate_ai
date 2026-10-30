# 0070 — Phone & SMS: bring-your-own Twilio, a number per agent, texts in the inbox (Phase 3.1)

**Status:** accepted, 2026-10-30 (the client approved the mocks `twilio-setup.html`, `missed-calls.html`;
the user: build 3.1 now with placeholder keys). Migration 0071 (additive, NOT applied). ROADMAP 3.1.

**Context.** Call Forwarding + Verified Caller ID (ROADMAP Phase 3): agents keep their phones; the calls
they miss forward to a Twilio number; texts and AI call-backs go out in the agent's name. Each agency
brings its own Twilio (the client's decision); the platform's own Retell runs AI calls later (3.3).

**Decision.**
1. **Own module, not an OAuth integration.** `packages/core/src/phone/`: `twilio.ts` (REST over injected
   `fetch`; a dev stub behind `PHONE_STUB=1`, never in production), `format.ts` (pure), `setup.ts`,
   `sms.ts`, `webhooks.ts`. Tables `phone_account` (one per agency; the API key secret encrypted with
   INTEGRATION_TOKEN_KEY, AAD `<id>:twilio_api_secret`), `phone_number` (one active per agent),
   `sms_message`, `sms_read`, `sms_opt_out`, `phone_call`. All carry `agency_id`; RLS on, no grants.
2. **Permissions.** `phone:manage` (owners/admins: connect, business check, get/release numbers),
   `phone:read` (any member), `phone:own` and `sms:send` (only the number's agent — it calls their mobile
   and texts in their name; not even the owner), `sms:read` (the agent, or owners/admins).
3. **Setup.** Connect = Account SID + API key SID + secret, checked against Twilio. KYC is read from
   Twilio's AU-mobile regulatory bundles (approved only on `twilio-approved`), on "Check now" and hourly
   from the minute tick. A number is bought only after approval, with its webhooks set, and the agent's
   profile mobile as the starting caller ID. The agent verifies the mobile (Twilio's OutgoingCallerIds:
   the page shows the code, polls until verified), dials the carrier's no-answer forwarding code (GSM
   `**61*<number>**<seconds>#`, PROVISIONAL until tried on each network), and runs a test call: the app
   calls the mobile from the Twilio number; forwarded back to that number within 5 minutes = passed.
4. **Webhooks** on the web app, `/api/phone/twilio/<token>/<sms|sms-status|voice|caller-id>`. A
   bring-your-own API key gives no Auth Token to check Twilio's signature, so the URL carries a
   per-number token: the number's id + an HMAC under a key derived from INTEGRATION_TOKEN_KEY. Bad token
   = 403 before any read. A text in is kept (idempotent on its SID), STOP/START honoured per agency, the
   agent notified. A call in is the test coming back, or a missed call: kept, the agent notified, and
   the caller hears "Sorry, <name> can't take your call right now" (forwarding replaces voicemail).
5. **Texts.** Inbox → Texts (agency: every number, read only; agent: their own). A conversation is (the
   agent's number, the other number). Sending: Australian mobiles only, ≤1600 characters, never to a
   STOP number, at most `SMS_LIMIT_PER_AGENT_DAY` (100) a day; the row is written queued before Twilio is
   called (outside any transaction), then sent or failed with a readable reason.
6. **Nothing is automatic.** No text or call goes out by itself in 3.1. The missed-call text (3.2) and the
   AI call back (3.3) are skills behind both the agency's and the agent's switch (ADR 0069).

**Not done.** 3.2 (missed-call text, greeting/settings, Missed Calls page), 3.3 (Retell), SMS from the
contact page, Twilio's Auth-Token signature as a second check, AddressSid if Twilio asks for it on buy.
