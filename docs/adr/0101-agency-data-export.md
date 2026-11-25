# 0101 — Agency data export: quick CSV, then a full zip

**Status:** accepted 2026-11-25 (the user's decisions in `docs/briefs/agency-data-export.md`). Phases 1, 2 and 3 built (phase 3's migration 0109 on dev only).

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
   query per page, so neither memory nor Vercel's response-size limit grows with the book. Each dataset is scoped by
   its own screen's rule: `leadScopeFilters` (offers only for `lead:read_offer`), `appointmentScopeFilters` (past
   and upcoming together), `visibleDealsSql` (every deal, settled and withdrawn too, though the board shows the open
   ones; `?mine=1` as the board's "Only mine"), and notes on the customers the member sees, private ones only for
   their author or an admin (`noteVisibleSql`). Notes have no list page: their button is on Customers.
2. *Full export* (phase 3). "Download all my data": `/settings/data` for owners and admins, `/my-data` for agents,
   same scope as their screens. An `export_job` row (migration 0109) holds its state; the job queue's `bulk` lane
   builds it one step per job, each step enqueuing the next, so no step outlives the minute tick:
   - one step per dataset: customers, listings, leads, appointments, deals, notes, activity, SMS, calls (with the
     AI call-back transcript), emails (full text), documents and photos (an index of each), and the team (owners
     and admins only). Each CSV is written to storage on its own;
   - one step packs them, with a README, into `data.zip`;
   - then the real files, `photos-N.zip` and `documents-N.zip`, each at most ~40 MB (Vercel's memory and Storage's
     default 50 MB upload limit), the files stored as they are (already compressed).
   The parts live in the private `documents` bucket under `exports/<agency>/<export>/` (no new bucket). When the
   last step is done the member gets a bell and an email that link to the page, never to a file; the page signs a
   60-second link per part on click, only for the member who asked. Parts are deleted 24 hours later (the hourly
   expiry), or at once if the export fails. One export at a time per member, at most 5 a day. The member must
   still be one when each step runs: someone removed mid-export gets a failed export, not the rest of it.
   The CSVs are read step by step, so they are not one snapshot: a row changed during the build may be in one file
   and not the next.

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
