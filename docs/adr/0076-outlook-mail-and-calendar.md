# 0076 — Outlook: send from Outlook, mirror appointments into Outlook Calendar, one active of each (Phase 5.2)

**Status:** accepted, 2026-10-31 (the user's four decisions). Migration 0077 (additive) APPLIED 2026-10-31 at the
user's go after a rolled-back dry run (twice; 8/8, then 5/5 with the Outlook values) — 78 recorded. ROADMAP 5.2.
No UI mock (the user: the cards follow the Gmail ones exactly).

**Context.** Many agencies run on Microsoft 365. Today a person can send from their own Gmail (ADR 0026, send
only) and mirror appointments into Google Calendar (ADR 0019); inbound email is ours (ADR 0016). The user decided
(2026-10-31): Outlook mail AND calendar this round (Teams links later); a person may connect both Google and
Microsoft but chooses which one is ACTIVE for mail and which for calendar; work/school (Microsoft 365) and
personal (Outlook.com / Hotmail) accounts both; no mock.

**Microsoft, as checked 2026-10-31** (learn.microsoft.com: user-sendmail, user-post-events, v2-oauth2-auth-code-flow):
- OAuth 2.0 auth code flow on the `common` tenant (both account kinds):
  `https://login.microsoftonline.com/common/oauth2/v2.0/{authorize,token}`, a confidential web app (client secret),
  PKCE as Microsoft recommends. A refresh token only with `offline_access`; each refresh returns a NEW refresh
  token that replaces the old one (we store it every time).
- Mail: `POST /v1.0/me/sendMail` with `Content-Type: text/plain` and the base64 MIME — our Gmail MIME builder
  unchanged, so threading headers (In-Reply-To, References) survive; saved to Sent Items; `202 Accepted`.
  Least privilege `Mail.Send` (work and personal). The mailbox is never read.
- Calendar: `POST /v1.0/me/events` (`201 Created`) with `transactionId` = our appointment id (no duplicate on a
  retry), `PATCH` / `DELETE /me/events/{id}`, `GET` to notice a move made in Outlook. Least privilege
  `Calendars.ReadWrite` (work and personal); only the events we created are read or changed.

**Decision.**
1. **Two providers** beside Google's: `outlook_mail` (owner: user or agency, like Gmail) and `outlook_calendar`
   (owner: user, like Google Calendar). Scopes, one place (`providers.ts`): mail `openid email offline_access
   User.Read Mail.Send`; calendar `openid email offline_access User.Read Calendars.ReadWrite`. The account label is
   Graph's `/me` `mail`, else `userPrincipalName` (personal accounts often have no `mail`).
2. **Adapters, no new engine.** `integrations/microsoft-oauth.ts` (authorize URL, code → tokens, refresh with
   rotation), `outlook-mail.ts` (send the same MIME), `outlook-calendar.ts` (the `calendarApi` interface the sync
   engine already takes). `mail/sender.ts` and `appointments/sync.ts` pick the ACTIVE provider; Microsoft's
   errors map to ours (401 → expired, 403 → permission missing, 429 → retry later with Retry-After).
3. **One active of each, per owner** — a table `integration_choice (agency_id, owner_type, owner_id, purpose
   'mail' | 'calendar', provider)`, unique per owner and purpose. No row: the only one connected. Connecting a
   second one records the first as chosen (in the connect's transaction), so it never switches by itself; both
   connected with no row (not reachable that way) falls to Google. The card of the
   other one says "Use this one instead". The agency mailbox follows the same rule (owners and admins choose;
   the "members may send from the agency mailbox" switch covers whichever is active).
4. **Switching the calendar** moves what is still ahead: each future appointment mirrored in the old calendar is
   deleted there and created in the new one by the sync job (the appointment row already records its provider
   and account). Past appointments stay where they are. Switching mail changes only what is sent next.
5. **Fail closed, as Google:** a disconnected or expired active provider is never silently swapped for the other
   one — the person sees "Outlook needs reconnecting" (mail falls back to the platform's address exactly as it
   does without Gmail today).

**Migration 0077.** Enum values `outlook_mail`, `outlook_calendar`; the owner-type CHECK compares
`provider::text` (a value added in the same transaction cannot be used as an enum literal); table
`integration_choice` (RLS on, no grants — server only, ADR 0017). Additive and idempotent.

**Checks.** Unit: a fake Microsoft (as Google's and Zoom's fakes) — authorize URL and scopes, refresh rotation
stored, MIME sent unchanged, events created with `transactionId`, the error mapping, the active-provider rule
(break-tested), a calendar switch moving only future appointments. Smoke: Outlook mail and calendar on the fake,
and an agent never using another agency's Microsoft token. Real Microsoft: needs the platform's Entra app
(`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, redirect URI = the existing OAuth return hop, ADR 0020) —
PROVISIONAL until tried live. Go-live: Microsoft publisher verification (else "unverified" consent and some
organisations require an admin to approve).
