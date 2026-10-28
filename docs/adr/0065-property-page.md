# 0065 — One property with everything on it

**Status:** accepted, 2026-10-27 (the user reviewed `docs/mocks/property-page.html` and chose the four
recommended answers). ROADMAP Phase 2.3. No migration.

**Context.** The brief's #10 and #6: one page per address with the owners, enquiries, appraisals, offers,
documents and pipeline, plus an AI summary. Everything already has a row that names the property
(`listing`, `lead`, `contact_property`, `appointment`, `inspection` through its listing, `document`, `deal`
and `deal_event`). The console has no page that puts them together; a contact's Properties tab links to the
public page, which shows only past campaigns.

**Decision.**
1. **A read, not a new record.** `packages/core/src/properties/` gathers what the agency has on one
   address. No new table: the page is the records that already exist, each through the rule that already
   decides who sees it — `leadScopeFilters` / `lead:read_offer` for enquiries and offers (an agent never
   sees an offer, as everywhere else), `visibleContactIdsSql` for people, `appointmentScopeFilters` for
   appraisals and visits, `documentScopeFilters` for documents, the pipeline's deal rule for the deal.
2. **Who may open a property** (decision 1): owners and admins, any address the agency has a record of.
   Anyone else, only an address they are tied to — a listing they are named on, their deal, an enquiry or
   appointment they may see, or a contact of theirs linked to it — and on it only the records they may
   see. Any other id is "not found", never "forbidden", so the page does not confirm the agency knows the
   address. One SQL rule, `visiblePropertyIdsSql`, used by the page and the list.
3. **A Properties list** (decision 2) at the top of the sidebar's Properties group: every address the
   actor may open, searchable by address or suburb, filtered by Listed now / In the pipeline / Appraised,
   not listed / Sold by us, newest activity first.
4. **Tabs** (decision 4), like the listing page, in the URL: Overview (summary, what has happened, the
   pipeline, people, documents), People, Enquiries & offers, Appraisals & visits, Documents, History (the
   agency's campaigns at the address). Writes stay where they are: the listing, the contact, the Deal tab.
5. **The summary is on a button and never saved** (decision 3), like the inbox's (ADR 0062). Core numbers
   every record the actor may see on the page; the model (packages/ai, one call, no tools, metered as
   `property:summary`) writes up to six points, each citing the records it came from; core drops a point
   that cites nothing real or states a figure its records do not contain. Under a new platform skill,
   **Property summaries** (ADR 0058, no row = on), the agency-wide AI budget, and its own per-agency cap
   (`PROPERTY_AI_DAILY_BUDGET_USD_PER_AGENCY`, default 2); `PROPERTY_AI=off` turns it off on a server.
6. **Numbers are SQL's** (#4): days on market, the highest offer and every price are read from the rows,
   never worked out by the model.

**Not done.** Editing on this page; a map; valuations or medians (no source); the assistant answering
"tell me about 12 Rogers St" from this read (later); other agencies' history at the address beyond what the
public page already shows.
