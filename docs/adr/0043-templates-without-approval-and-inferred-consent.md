# 0043 — Templates without approval, consent inferred from an enquiry, no 7-day rule

**Status:** ACCEPTED, 2026-10-14 (the user's three decisions, below). Amends ADR 0022 (template
email), ADR 0018 ("an enquiry is not consent") and ADR 0041 (workflows send only "approved"
templates).

## Context

The user (Roman Urdu, paraphrased): "When the agency or an agent makes an email template, it
should not need approval from the agency. And remove the permission needed before emailing
contacts." Asked to choose, they decided (2026-10-14):

1. **Templates.** No approval step. A template is ready to use the moment it is saved.
   - An agent's template is usable **only by that agent**.
   - An owner's or admin's template is usable by the **whole agency**.
2. **Consent.** A contact who **made an enquiry, or is a client**, is taken to have consented
   (the Spam Act's *inferred* consent, from an existing relationship). Everyone else still needs
   consent recorded.
3. **The 7-day rule** (one template email per contact per 7 days) is **removed**.

Two points were shown to the user before they decided:

- The Spam Act 2003 forbids marketing email without consent. **Consent is not removed.** Inferred
  consent is a lawful kind of it, and the user chose that.
- **A person who unsubscribed is never emailed**, whatever else is true.

## Decision

### 1. Templates are ready when saved

- `createTemplate` stores the template as `approved`, with `approved_by` = its author and
  `approved_at` = now. The column keeps its meaning: who made the text usable, and when.
- The new column `agency_wide` is true when an owner/admin makes it, and false when an agent does.
- **Who may send it:** its author, or anyone in the agency when it is `agency_wide`.
  - Every path that sends a template checks this one rule (`mayUseTemplate`): Bulk email, the
    assistant's `send_template_email`, the list send, workflows (as the workflow's owner, at
    save and at run), and the template-email skill.
- **Who sees it in the list:** templates they may use. Owners and admins see every template, so
  they can oversee and retire. An admin may not *send* an agent's private template.
- **Editing:** the author, or an admin, edits a template at any time.
  - A batch already prepared keeps its frozen copy (`template_snapshot`), so a sent email still
    traces to the exact words sent.
  - A workflow sends the template's current words.
- **Retiring:** its author or an admin.
- **Removed:** submit, approve and send back, and their buttons.
  - The enum keeps `draft` and `pending_approval` for old rows. The migration makes every
    `draft` or `pending_approval` template `approved` (non-admin authors → private).
  - Every template already `approved` becomes `agency_wide`, because an admin approved it for
    the agency.

### 2. Consent: recorded, or inferred from a relationship

A contact may receive a template email if they have **not unsubscribed**, are **not archived**,
have an email address, and have **consent**. Consent is any one of these:

- **recorded** — `marketing_consent_at` is set, as today (ADR 0022)
- **inferred from an enquiry** — a lead from them at this agency (an enquiry, inspection,
  appraisal or offer) in the **last 24 months**
- **inferred as a client** — they hold a `seller`, `landlord` or `tenant` role at the agency

Implementation:

- One SQL expression (`hasMarketingConsentSql`) is the only definition. It is used when
  recipients are classified at Prepare **and again at the moment of sending**.
- The skip reason for everyone else stays "No marketing consent recorded".
- "Buyer" and "investor" alone are **not** a relationship: those roles are often typed in or
  imported.

The 24 months and the three client roles are proposed defaults, marked as such below. The user
was advised to have a lawyer confirm them once.

### 3. No repeat window

- The 7-day rule is deleted: `recentlyEmailedSql`, `EMAIL_REPEAT_DAYS` and `repeatDays`.
- `recently_emailed` stays a skip reason only so that old batches still read correctly.
  Nothing produces it again.
- **Kept:** the per-batch size (20) and the daily caps (50 per agent, 200 per agency). These are
  sending limits that protect the domain's reputation, not permissions. Changing them is one
  environment variable each.

### Unchanged

- Unsubscribe, with a link in every template email.
- Sender identification.
- The development allowlist.
- Prepare → Approve & Send on Bulk email, so the agent still sees exactly who gets it.
- AI-written email is always a draft (non-negotiable #7 and ADR 0041 D1). This ADR is about
  **templates people wrote**.

## Data (migration 0053)

- Add `email_template.agency_wide boolean not null default false`.
- Backfill: every `approved` template becomes `agency_wide = true`. Every `draft` or
  `pending_approval` template becomes `approved` (by its author, now), and `agency_wide` = whether
  its author is an owner/admin today.

## Tests (each with its break-test)

| # | Invariant | Break → red |
|---|---|---|
| T1 | An agent's new template can be sent at once by its author; a colleague's batch refuses it; an admin's template works for everyone | Make `mayUseTemplate` ignore the author |
| T2 | Consent: recorded yes; an enquiry 3 months ago yes; one 30 months ago no; a seller yes; a buyer with no enquiry no; **unsubscribed never**, even with an enquiry | Drop the opt-out test |
| T3 | The same rule at send time: an unsubscribe after Prepare is still skipped | Re-check without the opt-out |
| T4 | A contact emailed yesterday is sent to again | — (a rule removed; the old smoke case is inverted) |
| T5 | Workflows and the assistant list only templates the person may use | Use the agency's list |

## Open (proposed defaults — confirm or change)

1. 24 months for an enquiry's inferred consent.
2. Client roles: seller, landlord and tenant (not buyer or investor).
3. Whether admins may mark an agent's template "for the whole agency" (not built; an admin can
   copy it).

## As built (2026-10-14, branch `feat/email-rules`; migration 0053 APPLIED)

- **Code.**
  - `mayUseTemplate` and `usableTemplateSql` in `template-email/templates.ts` hold the one rule
    for who may send a template. `classifyRecipients` asks it, so Bulk email, the assistant's
    card and list send, and workflow steps all go through it. `checkWorkflow` uses the SQL
    form, as the workflow's owner.
  - `hasMarketingConsentSql` in `template-email/consent.ts` is used at Prepare and at send.
  - `classify` tests the opt-out before consent.
- **Permissions.** `email_template:approve` became `email_template:manage` (owner/admin: their
  templates are agency-wide, and they see, edit and retire all). Submit, approve and send back
  are deleted, from core and from the console.
- **The 7-day rule is deleted.** That covers `recentlyEmailedSql`, `repeatDays` and
  `EMAIL_REPEAT_DAYS`. The batch size and the daily caps stay.
- **Assistant.** Prompt `assistant@v21`; the tool descriptions use the new wording.
  `list_templates` returns only templates the person may send.
- **Tests.**
  - `template-email/rules.test.ts` covers T1 and T2. Both break-tests went red: `mayUseTemplate`
    ignoring the author, and consent tested before the opt-out.
  - In smoke, "Template email" is 7/7, including a new consent check (8 contacts) and the
    inverted repeat check. "Workflows" is 6/6, "Tenant isolation" 4/4 and
    "Assistant part 2" 5/5.
- **Migration 0053** set the agency's one existing template (approved) to `agency_wide`.
