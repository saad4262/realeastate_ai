# 0034 — "Agents" widget: every agent's emails and work, on a dashboard

**Status:** ACCEPTED, 2026-10-10 (asked by the user, Roman Urdu: "a mini dashboard for the
agency with every agent — how many emails each received and which, how many they sent and
which, their name and details, and their other data"). Amends ADR 0027 (a new widget, a new
data kind and an optional section of the full-page report). No migration.

**Context.** The assistant can already save a dashboard and hand back its link (ADR 0027), but
no widget lists the people: `email_replies` is one number, and its "by agent" bars show the
top 20 by received mail only. The client's example: "create a dashboard with all agents' names
and all the emails they received today".

## Decision

1. **One more widget in the fixed registry: `agent_activity` ("Agents").** Params `{ range }`,
   default `today`. Permission `report:read_agency` (owners/admins) — it is a per-person
   performance view, like Number of sales. The model still only picks an id and a range.
2. **Who the people are:** every ACTIVE member of the agency (any role), with 0s when quiet,
   plus anyone who left but has mail in the range (marked "No longer in the agency"), plus one
   "Not assigned to anyone" row when some received mail has no agent — so the rows add up to
   the totals.
3. **Whose email is it** (the schema has no recipient-agent column, so it is defined here):
   - **Sent** = an outbound `mail_message` with `sent_by` = the person and status `sent`
     (failed sends are listed and counted apart, never as sent; queued ones are in flight).
   - **Received** = an inbound `mail_message` on a conversation whose agent is the person:
     the lead's `assigned_to`, else the contact's `assigned_to` (mail to the agency address).
   - An enquiry's opening message is a lead, not an email (ADR 0016) — it is the "New leads"
     column, never counted as an email.
   - Every message is read through `threadScopeFilters` AS THE VIEWER, as the inbox does.
4. **Per person:** name, email, phone, role; emails received, sent, failed; conversations
   awaiting a reply now (last message came in, lead not closed); new leads assigned in the
   range; appointments in the range (still on); active listings and contacts held now; the
   time of their latest email. **One statement.**
5. **Which emails:** the full page only (`detail`, ONE more statement) lists each person's
   messages in the range — time, in/out, the other party, subject, a 160-character plain-text
   snippet, status, and a link to the conversation in the inbox — newest first, at most 25 per
   person ("and 12 more — open the inbox"). Text is drawn as text, never HTML.
6. **The model never sees any of it.** `show_widget` still returns only "shown"; the card's
   preview line is a count. Email text is never handed to the model by this widget.

## Not done

- Per-person drill-down page, CSV export, agents seeing their own row (agents keep
  `email_replies` and their inbox). Each is a small follow-up if the client asks.

## As built (2026-10-10, branch `feat/agent-activity-widget`, no migration)

- Core `packages/core/src/widgets/agents.ts`: `agentActivity` (headline, one statement) and
  `agentsDetail` (full page, one statement; ≤ 25 emails per person). Registry id
  `agent_activity`, default range `today`, refresh 30 s. "New leads" leaves offers out, as
  the New leads widget does. `WidgetData` gains `kind: 'agents'`; `WidgetDetail` gains
  optional `people`.
- Console: `components/dashboards/agents.tsx` — tile (totals + busiest people), and on the
  full page a table of everyone plus a fold-out email list per person linking to the
  console's own inbox (`/inbox` or `/my-inbox`, from the surface header).
- Assistant: the tool enums pick it up from the registry; prompt `assistant@v10` names it and
  says what to propose for "a dashboard of all agents and their emails today".
- Smoke "Dashboards": a new check (A and B, mail in and out, failed, older, agency address,
  nobody's lead) against a hand-written count. Break-tests, each seen red then restored: no
  viewer scope (B's mail leaked), received by the lead's agent only (agency-address mail
  lost), only people with mail (the quiet agent vanished), failed counted as sent.
