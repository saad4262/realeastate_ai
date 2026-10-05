# 0018 — Contacts: one person, many roles, seen through what you could already open

**Status:** accepted, 2026-10-05. Migration 0020. CRM Phase 1.

**Context.** The client wants a CRM: everyone an agency deals with in one directory, and
anything a person enquires about or emails landing on their profile. Until now a person
existed only as text on each `lead` and `mail_thread` row.

**Decision.**
1. `contact` is one person **per agency** (the same buyer at two agencies is two contacts:
   notes, assignment and consent are each agency's own). Roles (seller, buyer, landlord,
   tenant, investor) are tags in `contact_role`, each marked `manual` or `inferred` — never
   separate tables. `contact_property` ties a person to an address they own/sell/rent;
   enquiries are NOT copied there, they are read from `lead.property_id`.
2. **Capture is in the database.** `public.contact_upsert` matches on lower-cased email
   within the agency and only fills blanks — automatic capture never overwrites what
   somebody typed. A `BEFORE INSERT` trigger on `lead` and on lead-less `mail_thread`
   calls it, so enquiries, offers, agency-address email, the seed and scripts all land
   on the person (the 0016 pattern). A colleague emailing the agency is not a contact.
   Existing rows: `pnpm --filter @repo/core contacts:backfill` (dry run, then `--apply`).
3. **Duplicates:** same email = same person, automatically. Same phone with a different
   email = a *suggestion* (`phone_key`), never a merge (user's decision: families share
   phones). Merge is admin-only and deletes nothing (`merged_into_id`).
4. **Visibility** (user's decisions, 2026-10-05; to change it, edit `can()` and
   `contacts/visibility.ts` — the smoke parity check fails if only one moves):
   admins see every contact; any other member sees a contact assigned to them, or met
   through a NON-OFFER lead they could already open, or tied to an address where they
   are named on the agency's listing. Inside a profile each lead and email still obeys
   `lead:*`/`mail:*`. Assigned contacts are fully editable by their agent; contacts met
   only through a lead are notes-only. Assistants and property managers follow the agent
   rule; read-only members view and write nothing.
5. Mail to the agency address from a contact is readable by whoever may see the contact
   and answerable by its assignee (before: admins only).
6. **Timeline:** a new `activity` table for events with no other home (created, updated,
   assigned, merged, role and consent changes; later appointments and skill actions).
   The timeline is a UNION of `lead`, `mail_message`, `note` and `activity`. The old
   `event` table is NOT reused: no agency, no contact, no foreign key, so tenancy would
   be a convention and every read a scan. It stays, empty, untouched.
7. **Consent:** an enquiry is not marketing consent. `marketing_consent_at/_by/_note`
   record an agent's "they said yes"; `email_opt_out_at` wins over it. To be settled
   before Phase 5 sends anything.

**Alternatives.** Contacts in app code instead of triggers (every write path must
remember; scripts would not). Auto-merge on phone (wrong for shared phones). Separate
buyer/seller tables (one person, many roles). Reusing `event` (see 6).

**Phase 2 (2026-10-05, migration 0021) — Contact 360.**
- Tabs: Overview, Timeline, Properties, Emails, Enquiries, Notes, Calendar and Reviews
  (the last two say "Not connected" until the integrations hub exists).
- Each tab reuses its screen's own rule: Enquiries = `listAgencyLeads({contactId})`;
  Emails = `listMailThreads({contactId})` drawn with the inbox's own `ThreadList` and
  `ThreadReader`; the timeline and the counts apply `leadScopeFilters` /
  `threadScopeFilters`, the inbox's filters factored out. So a tab or a count never
  shows an agent a lead or email their inbox would not.
- Timeline is one UNION ALL query (lead, mail_message, note, activity), with a
  (time, id) cursor.
- Properties are the `contact_property` ties plus addresses from scoped leads, and
  link to `/property/[id]`. Only an address the agency has listed or been asked about
  can be linked; a brand-new address needs geocoding, which is later.
- Notes: anyone who sees the contact reads them; read-only members write none; the
  author or an admin edits or deletes. A delete sets `note.deleted_at` and keeps the row.
- Archive (`contact.archived_at`, `contact:archive` = the edit rule) hides a contact
  from the directory's default view. Nothing else changes, and a new enquiry still
  lands on the same row (no "unconfirmed" state — the user's decision).
- Merge button on "Possible duplicates" (admins). Assigning a contact emails the new
  assignee (transactional, `notifyContactAssigned`): not on self-assignment, and not
  once it has been reassigned again.

**Phase 2 follow-up (2026-10-05, migration 0022) — the user's decisions.**
- Notes stay visible to everyone who can see the contact, but a note may be ticked
  **Private (admins only)**: then only the agency's admins and its author see it
  (`note:read_private`). One filter, `noteVisibleSql`, is applied by the Notes tab,
  the timeline and the counts, so a private note cannot leak through any of them.
  The client should still confirm whether this is enough.
- A contact can be tied to a **brand-new address** (an owner's or vendor's home that
  is not listed), with the listing form's address picker. Geocoding happens before
  the write; `upsertProperty(…, { leaveExisting: true })` finds the existing property
  for that address or makes one, and NEVER changes an existing property (another
  agency's pin or facts). A home added this way is not public: `/property/[id]`
  renders only for an address that was once public.
- Removing a property link stays a hard delete; the timeline records it.

**Not done.** Last-activity column in the directory; `contact.user_id` (set only once
an account proves the address); appointments (Phase 3).
