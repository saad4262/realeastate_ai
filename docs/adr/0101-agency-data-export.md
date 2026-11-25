# 0101 — Agency data export: quick CSV, then a full zip

**Status:** accepted 2026-11-25 (the user's decisions in `docs/briefs/agency-data-export.md`). Phase 1 built; phases 2–3 to come.

**Why.** An agency must be able to take its data away, any day, without asking us. ADR 0030 §5 and ADR 0093
cover the agency that leaves (a platform operator runs a JSON-lines export). This ADR covers the agency that stays:
a member downloads its data from the console.

**Who (the user, locked).** Agents AND owners/admins, always scoped: a member gets exactly the rows their screens
show them, through the same scope helpers (`contactQueryFilters`/`visibleContactIdsSql`, `listingScopeFilters`).
An owner or admin gets the whole agency; an agent their own book. One action, `data:export`: any member of the
agency. It is not in `PLATFORM_READ`, so a platform admin's read-only view cannot bulk-download an agency's people.

**Two ways.**
1. *Quick export* (phase 1: Customers, Listings; phase 2: Leads, Appointments, Deals, Notes). A button on the list
   page; the rows the page's filters select, every page of them. Streamed in pages of 1,000 (keyset on `id`), one
   query per page, so neither memory nor Vercel's response-size limit grows with the book.
2. *Full export* (phase 3). "Download all my data" in Settings → Data, for every member, same scope: one CSV per
   dataset (full SMS, email and call bodies included), the real photo and document files in `photos/` and
   `documents/`, and a README. Built by the minute cron into a private Storage bucket; the member gets an email and
   a link that expires in 24 hours. Needs an `export_job` table (a migration, asked before production).

**The file.** UTF-8 with a byte-order mark (Excel reads it right), CRLF, every cell through `csvCell` (quoted; a
cell starting `= + - @`, tab or CR is prefixed with `'` so opening it runs nothing). Headers are the import's own
(`IMPORT_FIELDS`, `CONTACT_IMPORT_FIELDS`), so a file goes back in through the import; extra columns (`id`,
`created_at`, …) come after them and the import ignores them. Dates on the property's clock for listings, the
agency's for customers. Numbers come from the numeric columns, never parsed from `price_display`.

**Audit.** Every export writes `data_exported` to `audit_log` before the first byte leaves (dataset, scope, filters
named, never values), and adds the row count when it finishes, or `complete: false` if the download stops. Owners
and admins see it on the audit page.

**Never exported** (also in phase 3): secrets (OAuth tokens, Twilio keys, invite tokens); AI internals (`ai_run`,
embeddings, `proposed_action`, skill runs); platform logs (`platform_*`, `site_activity`); public geo data; what
belongs to a consumer rather than the agency (shortlists, property watches, buyer profiles, inspection notes);
listing-activity viewer identity (ADR 0083) until the privacy policy covers it.

**Not yet checked.** The Australian Privacy Act, line by line. Before real customers the privacy policy must say
that members can download customer data, and who can download what.
