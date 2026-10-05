# 0022 — The "send a template email to N contacts" skill (DECIDED — not built yet)

**Status:** decisions agreed with the user 2026-10-05 (see "Decided" below). NOT BUILT — the user reports
the N–R browser tests first.

**Context.** Agents want to email a template ("New listing in your street", "Market update")
to a handful of contacts in one go. This is MARKETING email in the agency's name to third
parties: Spam Act 2003 (consent, sender identification, functional unsubscribe) and
non-negotiable #7 (AI copy reaching a third party needs a human).

**Decision (proposed).**
1. **Who can receive it.** Only contacts that:
   - have `marketing_consent_at` set (an enquiry is not consent — ADR 0018),
   - have no `email_opt_out_at`,
   - have an email, are not archived, not merged,
   - the agent may see (`contact:read`), and
   - were not sent any template email in the last **7 days** (a `mail_message` of kind
     `template_email` to that contact).
   Everyone filtered out is listed in the preview with the reason — nobody silently
   dropped.
2. **Limits**, all from configuration, admin-adjustable in a settings row (env defaults
   until then): **20 recipients per run**, **50 per agent per day**, **200 per agency per
   day** (shared with every other platform-composed email — `email/limits.ts` and
   `mail_message.kind`), **7 days** between template emails to the same person.
   Checked at preview and again at send; a run that would cross a limit sends nothing
   and says which limit.
3. **Unsubscribe.** Every template email carries a one-click unsubscribe link and the
   `List-Unsubscribe` header (it is a `marketing` message in `transport.ts`), reusing the
   `/unsubscribe` route with a second, signed token kind (`contact:<id>`), which sets
   `email_opt_out_at` — a dated record. Plus sender name and postal address (as alerts).
4. **The template** is an agency-approved text with merge fields from SQL only (`{first
   name}`, `{agent name}`, `{suburb}`); no model writes it. If AI drafting is added
   later, a draft is always a draft (#7) — a person edits and approves it like any other.
5. **Preview + explicit Approve.** The run never sends on a schedule by itself. A
   scheduled run *prepares* a batch (recipients, the rendered email per person, every
   exclusion and why) and notifies the agent; only **Approve & send** sends it, after
   every check is repeated. A batch not approved within 48 h expires.
6. **Sending** goes through the existing pipeline: one `mail_message` (kind
   `template_email`) per recipient in a conversation with that contact, so replies land in
   the console; batched (e.g. 10 at a time) after the transaction, with failures shown and
   retryable.
7. **Records.** An `activity` row on each recipient's contact ("Template email sent:
   <template name>", with the message id); excluded contacts get nothing. The skill_run
   records counts sent / excluded / failed — from SQL.

**Decided (the user, 2026-10-05) — these override anything above that differs.**
1. **Templates are approved by an owner/admin.** Agents may draft a template, but a bulk
   send can only use an approved one.
2. **No scheduled sending.** Only a manual **Prepare**, then the agent clicks
   **Approve & Send**. (Point 5's "scheduled run prepares a batch" is dropped for now.)
3. **Recipients** come from a saved directory filter. The resolved list is **frozen at
   Prepare** and shown in full before approval: the count, every name, and everyone
   skipped with the reason (opted out, archived, emailed in the last 7 days, no consent…).
   Opt-out and consent are **checked again at the moment of sending** — someone who opts
   out between Prepare and Send is not emailed.
4. **48 hours** to approve; an expired batch must be prepared again.

**Alternatives.** Sending without consent filtering (unlawful). Auto-send on schedule
(fails #7 and "no silent sending").
