# 0019 — Appointments are ours; calendars will mirror them

**Status:** accepted, 2026-10-05. Migration 0023. CRM Phase 3a (no Zoom, no Google yet).

**Context.** Agents book appraisals, calls, inspections and meetings with contacts. Google
Calendar and Zoom come later (Phase 3b); the record has to exist, be scoped and show on a
contact's timeline before either is connected.

**Decision.**
1. `appointment` is the platform's own record: contact (required), related property
   (optional, one of the contact's), assigned agent, title, type, status, instants, the
   booking zone, location / meeting link, internal notes, outcome, attendees (JSON:
   name + optional email), a reminder choice (stored; sending is a later phase), and
   `external_calendar_id` / `external_calendar_provider` / `zoom_meeting_id`, empty until
   3b fills them. Google and Zoom mirror this row; they never own it.
2. **Visibility** (`can()` + `appointmentScopeFilters`, its SQL twin): admins see and
   change the agency's whole calendar; any other member sees appointments assigned to them
   or that they booked — never another agent's, even with a contact they share. Only the
   assigned agent or an admin changes one. Read-only members see their own and change
   nothing. Booking needs `contact:read` on the contact; only admins book for somebody else.
3. **Times:** stored as UTC instants plus the IANA zone they were booked in. The browser
   turns what the agent typed, on their own clock, into instants before sending
   (`@repo/core/time`); the server never interprets a wall-clock time, and every screen
   shows each viewer their own browser's time. An email prints the booked zone, named.
   `time/local-input.test.ts` runs pinned to UTC and goes red on the naive `new Date(typed)`.
4. **Changes** — book, reschedule (status `rescheduled`, from → to), complete, cancel, with
   an outcome note — each write an `activity` row in the same transaction, so the contact's
   timeline shows them. Finished appointments cannot be changed again.
5. **Invitation email** is never automatic: an unticked-by-default box opens the exact
   preview, and only Send sends. It goes through the conversation pipeline (ADR 0016) in a
   new conversation with the contact, so their reply lands in the console. Transactional
   (about their own appointment); the internal notes are never in it. It counts toward the
   daily sending limits.
6. **Sending limits** (`email/limits.ts`): `EMAIL_LIMIT_PER_AGENT_DAY` (50) and
   `EMAIL_LIMIT_PER_AGENCY_DAY` (200), rolling 24 h, counted from `mail_message.kind` — set
   only on platform-composed mail, so a person's own reply to a buyer is never counted or
   blocked. From the environment until an admin setting replaces it (Phase 5).

**Alternatives.** Google Calendar as the source of truth (agents without Google would have
no calendar; scoping would be Google's). An attendees table (nothing queries attendees yet).
Server-side date formatting (the bug fixed once already).

**Not done.** Week grid (a day-grouped list instead); sending reminders; .ics attachments
(the transport does not send attachments yet); booking from /calendar without a contact.
