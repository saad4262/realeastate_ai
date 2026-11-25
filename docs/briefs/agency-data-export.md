# Brief — Agency data export (Quick CSV + Full zip)

**From:** the user, via Cursor, 2026-11-25  
**To:** Claude Code (next session)  
**Status:** decisions locked — write ADR, then build phase 1

## User decisions (locked)

1. **Who can export:** both **agents** and **agency** (owner/admin).  
   - Agent: only records in their normal scope (same helpers the screens use — their contacts, their listings, etc.).  
   - Owner/admin: whole agency.  
   - Full “Download all my data” zip: available to **both**, still scoped (agent = their slice + their files; owner/admin = whole agency). Do not let an agent pull another agent’s customers.

2. **Full export contents:** **everything** that is agency business data (listings, customers, leads, appointments, deals, notes, activity, SMS, calls, emails/mail, team) — including **full message bodies**, not metadata-only.

3. **Photos and documents:** **real files** in the zip (`documents/`, `photos/`), properly — not links-only. Plus CSVs that reference them by id/path so the pack is usable offline.

## Still never export (hard exclusions)

- Secrets/tokens: `integration_account`, `phone_account`, etc.  
- AI internals: `ai_run`, embeddings, `proposed_action`, skill runs.  
- Platform logs: `platform_*`, `site_activity`.  
- Shared public geo: `place_cache`, census, zones.  
- Consumer-only data the agency did not collect: shortlist, property_watch, buyer_profile (agency gets the **lead/enquiry** the consumer sent, not the consumer’s private shortlist).  
- Listing-activity viewer identity (ADR 0083 privacy still open) — leave out until policy covers it.

## Build order

1. **ADR** (short): Quick vs Full, permissions (`can()`), audit (`export_job`), exclusions, zip + 24h link, ADR 0030 decision 5. Ask only if a house-rule conflict appears.  
2. **Phase 1 — Quick export:** Customers + Listings CSV buttons (filtered rows, stream, `csvCell`, UTF-8 BOM, import-compatible headers). Permission tests + tenant isolation.  
3. **Phase 2 — Quick export:** Leads, Appointments, Deals, Notes (same skeleton).  
4. **Phase 3 — Full export:** `export_job` migration, minute-cron builder, zip (CSVs + documents + photos + README), private Storage, email + expiring link, Settings → Data UI, audit visible to owner (and agent sees their own jobs).  
5. Later if asked: xlsx, scheduled export, public API.

## House rules

- Logic in `packages/core/src/exports/` (or equivalent). No business logic only in apps.  
- `can(actor, …)` only — never `user.role ===`. Every new endpoint needs a permission test.  
- Same scope helpers as list screens.  
- Keyset / paged reads (no N+1; `query-count.test.ts` will catch it).  
- Network (signed URLs / Storage fetch) outside transactions.  
- Reuse `csvCell` from `packages/core/src/imports/csv.ts`.  
- Before push of console/web: full relevant build, not lint tail.  
- **Ask before merge / production migration / live.**

## Privacy note (tell the user in the ADR)

Australian Privacy Act not line-checked in this brief. Before real customers: privacy policy must mention export and who can download what. Logging every export (who, when, which dataset, row count) is required.

## Done for phase 1 looks like

- Owner and agent can download Customers and Listings CSV from the console, scoped correctly.  
- Agent A never sees Agency B or Agent B’s out-of-scope rows (isolation test).  
- Formula-safe cells + BOM.  
- ADR committed. User asked before live.
