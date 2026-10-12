# ADR 0038 — Team meetings: internal Zoom meetings between members

**Status:** ACCEPTED and BUILT, 2026-10-12 (the user's answers under "Decided"; "As built" at the end). Migration 0044 applied on dev. Asked by the user (Roman Urdu): "we need a proper feature to
book internal Zoom meetings with team members, where everyone gets an email, the join link and
reminders." Builds on ADR 0019 (appointments), 0020 (Zoom/Calendar sync), 0032 (reminders, no
double booking), 0035 (team messages).

## Context
An appointment today is always **with a contact** (`appointment.contact_id` NOT NULL) and belongs
to **one** member (`assigned_agent_id`). Only that member and the booker see it, get the bell and
email reminder, and have it mirrored to their Google Calendar; only the contact gets the invitation
email. `attendees` is a free-text list that nobody is told about. So "Zoom meeting with Saad" (a
member) has nowhere to go: on 2026-10-12 the assistant sent Saad a team message instead, with no
meeting and no link.

## Decision
1. **One appointment table, a new kind.** `appointment.kind` = `client` (today, default) | `team`.
   A team meeting has no contact: `contact_id` becomes nullable with
   `CHECK ((kind = 'client') = (contact_id is not null))`. The host is `assigned_agent_id` (the
   person whose Zoom hosts it). Everything that already works for appointments — Zoom create /
   move / delete, the host's Google Calendar mirror, reminders, the clash check, Calendar page,
   cancel / reschedule / complete, offboarding — is reused, not rebuilt.
   Rejected: a separate `team_meeting` table (a second copy of sync, reminders and clash logic).
2. **Participants table.** `appointment_participant (appointment_id, user_id, agency_id,
   added_at, notified_at, declined_at)`, PK (appointment_id, user_id), RLS on, no browser grants
   (ADR 0017). 1–10 ACTIVE members of the same agency besides the host. Used only by `team`
   meetings in this ADR.
3. **Who sees and changes it** (`can()`, permissions.ts):
   - `appointment:read`: today's rule **or** the actor is a participant. Scope filter gains
     `exists (participant = me)`.
   - `appointment:update` (move, cancel, edit participants): the host, the booker, owner/admin.
     A participant may only **decline** (new action `appointment:respond`, own row only).
   - Owners/admins see every team meeting in full, agenda and Join link included, as they see
     every client appointment today (`appointment:read_all`, unchanged) — decided Q1.
4. **No double booking for anyone on it.** The EXCLUDE constraint covers only the host. Core
   checks every participant's active meetings (as host or participant) and refuses with the
   person's name and the clashing time. Races: the booking transaction takes
   `pg_advisory_xact_lock` per participant (sorted ids) before the check.
5. **Everyone is told, by template, never by a model.** On booking — after the Zoom meeting exists
   (same order as ADR 0032 §1; if Zoom fails, nobody is emailed and the host sees Retry) — each
   participant gets a console bell notification and an email: title, time in the agency's time
   zone, host, the other people, agenda, **Join Zoom** link, a link to the meeting in the console,
   and an `.ics` attachment so it lands in any calendar. A reschedule or cancel sends a "moved" /
   "cancelled" notice the same way (automatic — it reaches only members, so non-negotiable 7's
   third-party rule does not apply, and no text is model-written). A decline notifies the host.
6. **Reminders** (ADR 0032 §4) extend to every participant who has not declined: bell + email at
   the reminder time, claimed once per appointment as today.
7. **Booking.** Console: Calendar → **+ Team meeting** (title, people picker of active colleagues,
   date/time, duration, Zoom / phone / in person + location, agenda, reminder). Assistant: a new
   write tool `schedule_team_meeting` with a card (people, time, whose Zoom, "everyone is emailed
   the link"), approved like every write tool; prompt version bump. `schedule_appointment` keeps
   refusing members, and the prompt tells the model to use the new tool when the person named is
   a colleague (`find_colleagues`, ADR 0035).
8. **Where it shows.** The participant's Calendar page and "Upcoming meetings" on Overview, with
   Join. Not on contact pages, not on the public website (`customer-meetings` joins `contact`, so a
   team meeting can never appear there), and not in client widgets (see Q4).
9. **Offboarding** (ADR 0030): a leaving participant is removed from upcoming team meetings and the
   host is notified; a leaving host's team meetings move to the receiver like any appointment.

## Consequences
- Migration 0044: enum/column `kind`, `contact_id` nullable + CHECK, `appointment_participant`
  (+ RLS, indexes on (user_id) and (appointment_id)), the `proposed_action` tool CHECK widened for
  `schedule_team_meeting`. Additive; existing rows become `kind = 'client'`.
- Every reader that assumes a contact must be audited: `appointments.ts` (views type
  `contactId: string` → nullable), `sync.ts` (calendar description), `invitation.ts` (refuse team),
  `reminders.ts`, `clash.ts`, `customer-meetings.ts`, `widgets/registry.ts` + `detail.ts`,
  `assistant/tools.ts`, `team/offboarding.ts`, `isolation` tables list. A unit guard + smoke checks
  (participant reads, non-participant refused, clash across participants, reminder fan-out,
  offboarding), and a permission test for each new action and endpoint.
- Phase 2, not in this ADR: mirroring into each participant's own Google Calendar (needs per-person
  sync state); RSVP "accept"; recurring team meetings.

## Decided (the user, 2026-10-12)
- **Q1** Owners/admins see team meetings they are not on: **yes, in full** (title, time, people,
  agenda, Join link) — the same as client appointments. Unlike team messages (ADR 0035), a meeting
  is on the agency's calendar, not a private conversation.
- **Q2** Participants' calendars: **an `.ics` attachment** on every booking / move / cancel email
  (same UID, rising SEQUENCE, so a calendar updates the one event). Per-person Google mirroring
  stays Phase 2.
- **Q3** Who books: **any member who may write** (`appointment:create`, unchanged); read-only
  members cannot.
- **Q4** Widgets: **no** — "Upcoming appointments" and the dashboard figures count `kind = 'client'`
  only; team meetings get their own list on Overview.

## As built (2026-10-12, branch `feat/team-meetings`)
- **DB (0044):** enum `appointment_kind`, `appointment.kind` (default `client`), `contact_id`
  nullable + `appointment_kind_contact_check`, table `appointment_participant` (PK appointment+user,
  `declined_at`, own `agency_id`, RLS on), `proposed_action` tool CHECK + `schedule_team_meeting`.
- **Core:** `scheduleTeamMeeting` / `declineTeamMeeting` (appointments.ts; advisory lock per person,
  re-check inside the transaction); `findClash` now counts a team meeting a person is on (not
  declined), `findFirstClash` + `teamClashMessage`; reschedule checks every colleague still coming.
  `team-meetings.ts`: `notifyTeamMeeting` (bell + email, dedupe per event/version), `tellTeamMeeting`
  (marks `invitation_sent_at` = "its people were told about this time"), `bookTeamMeeting`
  (book → sync → tell) and `tellIfUntold` (after Retry when Zoom failed). `ics.ts`: PUBLISH, UTC,
  one UID per meeting, SEQUENCE = seconds since 2026-01-01 of `updated_at`. Email transport gained
  `attachments` (Resend `content` base64 + `content_type`). Reminders fan out to colleagues.
  Client-only readers left-join `contact`; a client invitation refuses a team meeting; widgets
  (upcoming_appointments, its detail, agent_activity) filter `kind = 'client'`; offboarding takes
  a leaver off team meetings (host gets a bell `team_meeting_left`) and drops a receiver's own
  participant row on meetings they now host; the morning brief names the colleagues.
- **Permissions:** `appointment:read` + participants; new `appointment:respond` (decline, own row).
- **Console:** Calendar → **+ Team meeting** panel (colleague picker, Zoom/phone/in person, agenda,
  reminder, host for admins); agenda cards show Host / With (declined struck through), Agenda,
  "Can't make it"; move/cancel tell everyone; Retry tells them if Zoom had failed; Upcoming
  meetings shows team meetings (not ones you declined).
- **Assistant:** `schedule_team_meeting` (colleagues by `M` reference; card shows the agenda text
  if any, as model-written), prompt `assistant@v12`; run-later uses the same path.
- **Not built:** changing who is on a meeting after booking (cancel and book again); the assistant
  moving or cancelling a team meeting (it points to the Calendar page); per-person Google Calendar
  mirroring (Phase 2; the `.ics` stands in). How a calendar app treats a cancelled PUBLISH event
  varies — some keep it with "Cancelled".
