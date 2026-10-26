# 0054 — Proactive opportunities

**Status:** accepted, 2026-10-26. Built on `feat/documents` (migration 0062).

**Context.** The brief's #2 asks for "a skill that finds things to do and ways to improve the business":
the assistant today only answers. The first step is the platform noticing, by itself, the moments an
agent would want to act on — a client who bought five years ago, an email nobody answered — and
putting them in front of the right person.

**Decision.**
1. **Detectors are SQL, nothing else** (non-negotiable 4). Five, in `opportunities/detectors.ts`:
   `sale_anniversary` (a listing sold 5 or 10 years ago, within 30 days after the date, its owner or
   vendor contact), `cold_contact` (a contact with a lead or a role, nothing in 90 days), `unanswered_mail`
   (an inbound email 48 hours to 21 days old with no reply since; never an offer's thread),
   `appraisal_follow_up` (an appraisal 3–30 days ago with no note, email or later appointment since),
   `repeat_interest` (3+ enquiries in 30 days). Thresholds are constants, not settings, in v1.
2. **One recipient, the person whose work it is:** the contact's (or the lead's) assignee, or a sold
   listing's lead agent — and only while an active member of a non-suspended agency. Nobody assigned →
   no opportunity (v1); nobody else is told.
3. **`opportunity` rows, unique on (agency, dedupe_key).** The key carries what makes it new (the
   anniversary year, the last touch, the latest inbound email, the latest enquiry), so the hourly scan is
   idempotent and a dismissed one never comes back until something real changes. Open ones expire after
   30 days. Facts (dates, a sold price) are stored as SQL returned them; every sentence on screen is a
   template over them. No model writes or ranks anything in v1.
4. **An hourly cron, not a skill** (`/api/cron/opportunities`): a skill must be switched on per agent;
   noticing should work for everyone from day one. The scan claims nothing and writes with
   `on conflict do nothing`, so overlapping runs are harmless. At most 10 new per person per run.
5. **Told once per scan:** one bell notification per person ("3 new opportunities"), linking to the
   Opportunities panel on their assistant home.
6. **The panel only links and records.** Open (the contact, the conversation), Ask the assistant (the
   home with the contact selected and a question typed in the box — the person presses Send; nothing is
   sent for them), Done, Dismiss. `opportunity:read` / `opportunity:update`: the recipient, inside the
   agency; a row whose contact they can no longer see is not shown.

**Not done.** Agency settings for the thresholds; a workflow trigger `opportunity.detected`; an assistant
tool to list them; model-written wording or ranking; unassigned work routed to admins; seller-intent
detection from conversations.
