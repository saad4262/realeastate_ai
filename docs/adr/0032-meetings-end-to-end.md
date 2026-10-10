# ADR 0032 — Meetings end to end: assistant invites, reminders, no double booking

**Built 2026-10-10 (migration 0039, applied on dev).** See "As built" at the end.

## Context
Users asked (2026-10-10): "schedule a Zoom meeting at 8 PM and email the link", said once to the
assistant, on the agent and agency consoles. Today the assistant books (ADR 0025 C) but never
sends the invitation (ADR 0019 keeps it a manual Send), Google Calendar is required even for a
Zoom-only meeting, `reminder_minutes` is stored but nothing sends it, one agent can be booked
twice at the same time, and a buyer has no place on the website to see their meetings.

## Decision
1. **One card, two steps.** `schedule_appointment` takes `send_invitation`. The card shows the
   recipient and says the invitation goes out after the meeting exists. Approve → book → sync
   (the Zoom link) → `sendInvitation` (ADR 0019's template, every check repeated). The text is
   still a template and the person still approves it, so non-negotiable 7 holds. If Zoom fails
   to create the meeting, no invitation goes out and the card says so.
2. **Google Calendar is optional for the assistant**, the same as the Schedule panel. A Zoom
   meeting needs only Zoom. If a calendar is connected, the event is mirrored.
3. **No overlapping meetings per agent.** A Postgres EXCLUDE on (assigned_agent_id,
   tstzrange(starts_at, ends_at)) for active statuses (btree_gist). Core checks first so the
   person gets a readable message, and the constraint catches races. Different agents may meet
   at the same time.
4. **Reminders, 15 minutes by default**, sent by the existing 5-minute cron tick. They go to
   whoever booked the meeting and the agent it is assigned to: as an in-app `notification` row
   (the console bell) and as an email. The contact gets a reminder email only if they were
   sent the invitation. Each appointment is claimed once with `reminder_sent_at`; a reschedule
   clears it.
5. **The buyer's website** gets `/account/meetings`: upcoming meetings with Join, plus a
   "starting soon" banner. It is shown only for a proved address and only for meetings they were
   invited to (the same rule as /account/messages, ADR 0016).

## Alternatives
Agency-wide exclusion (rejected: two agents meeting different people at 8 PM is normal).
Push or SMS (deferred: needs a provider). A model-written invitation (rejected: #7).

## Consequences
Migration 0039 (extension, constraint, column, table). Assistant prompt v8. A tick that is late
by up to 5 minutes sends the reminder 10–15 minutes before the start.

## As built
- Core: `appointments/clash.ts` (findClash, isOverlapViolation), `appointments/reminders.ts`
  (runReminderTick), `appointments/customer-meetings.ts`, `notifications/`. Offboarding queues
  any appointment that would clash with the receiver ("Needs an owner") and does not fail.
- `DEFAULT_REMINDER_MINUTES = 15` applies when a booking says nothing; "No reminder" is an
  explicit null. Rows from before 0039 that have a null reminder get no reminder.
- Permissions: `notification:read` / `notification:update` (own rows only, not admins) and
  `meeting:read_own` (a website account). Prompt `assistant@v8`.
- UI: the console bell (polls every 60 s while the tab is visible, with a toast for a new
  reminder), "Upcoming meetings" on /overview and the agent's /listings, the website's
  /account/meetings.
- Not done: no push or SMS; a reschedule does not re-send the invitation by itself (it never
  did); the assistant cannot book on another agent's calendar.
