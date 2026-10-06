# 0029 — Google Sheets and bulk CSV listing import

**Status:** ACCEPTED, 2026-10-06. Not built. **Supersedes ADR 0024** (its client decisions stand; this adds the design). The client asked us to define the CSV ourselves: the template is under "Decided".

**Context.** An agency moving onto the platform brings 2,000–3,000 listings, as a CSV export
or a Google Sheet. The rules: an owner/admin import goes live (or, by choice, draft); an
agent's import goes through admin approval (ADR 0014); Sheets may reach only the file the
person picks; one address is one property (ADR 0013); geocoding happens before any
transaction (CLAUDE.md); a property is not a listing (#1).

## Decision

1. **An import is a job, staged, never one request.** Upload → **map columns** → **dry run**
   (every row validated, geocoded through `place_cache`, matched, nothing written to
   listings) → person reviews the row-by-row report → **Import** → rows processed in chunks
   → report. Every stage is resumable; closing the tab loses nothing.
2. **Data model** (additive migration, RLS on, no grants):
   - `listing_import` — id, agency_id, created_by, source (`csv` | `sheet`), file name or sheet
     id + tab, file hash (sha-256 of the bytes), `mode` (`live` | `draft` | `pending`),
     `mapping` (jsonb: source column → our field, plus value maps such as "Sold" → `sold`),
     status (`uploaded` → `mapped` → `validated` → `importing` → `done` | `failed` |
     `cancelled`), counts (total / valid / errors / duplicates / imported / failed / photos
     pending), started_at, finished_at.
   - `listing_import_row` — import_id, row_number, `raw` (jsonb, the cells), `normalized`
     (jsonb, after mapping), status (`valid` | `error` | `duplicate` | `skipped` | `imported`
     | `failed`), `errors` (jsonb: `[{ column, message }]`), matched property_id, created
     listing_id, `external_id` (the agency's own listing id from their old system, if a column
     has one), photo status.
   - The uploaded CSV is stored in Supabase Storage (private bucket, deleted 30 days after the
     import finishes); a Sheet is re-read from Google at each stage.
3. **Who and what mode** (`can()` decides; ADR 0024 §1):
   - owner/admin: **Live** (default) or **Draft**;
   - agent: always `pending` — the rows become listings submitted for approval, the existing
     `listing:submit` → admin `listing:publish` flow, listed on the admin's approvals screen as
     "From import <file name> by <agent>"; the agent is the listing agent on each.
4. **Column mapping screen.** The first 20 rows shown as a table; for each of our fields a
   dropdown of the file's columns, pre-filled by matching header names
   ("Address", "Street address" → address; "Beds" → bedrooms). Value mapping for enumerations
   (status, channel, property type) shows the distinct values found and asks what each means.
   A mapping can be saved per agency and reused for the next file. Required fields are marked;
   Import is disabled until they are mapped.
5. **Dry run report**, row by row: ✓ valid, ⚠ duplicate (with what it matched), ✗ error (each
   problem in plain words: "Row 214: price '$1.2m–1.3m' — write it as two numbers or put it in
   Price text"). Download the report as CSV. Fix the file and re-upload, or exclude rows. The
   dry run writes nothing but the import tables.
6. **Prices:** `price_display` (text, as the file has it) AND `price_from`/`price_to` (numbers)
   are both stored (#6). The numbers come from mapped numeric columns, or from a strict parse of
   simple forms ("$850,000", "850000") at import time; anything else keeps the text and leaves
   the numbers empty with a ⚠ ("searchable by price only once numbers are added"). Never parsed
   at query time.
7. **Addresses and duplicates.** Each row's address is geocoded (place_cache first) and
   matched by `upsertProperty`'s address key (ADR 0013) — so a row lands on the existing
   property when there is one. Then:
   - the agency already has an **active listing** (draft/pending/live/under_offer) on that
     property → **duplicate**, default **Skip** (option: **Update** that listing's fields from
     the row, owner/admin only — open question 3);
   - same `external_id` as a listing from an earlier import → that listing (re-import updates
     instead of duplicating);
   - two rows in the same file with the same address and channel → the second is a duplicate of
     the first;
   - another agency's listing on the same property is **not** a duplicate (different agency,
     ADR 0013 history).
   An address Google cannot place with confidence is ✗ "Check the address", never guessed.
8. **Photos** — the one thing we cannot design without the sample (see the list below). The
   plan for the likely formats:
   - **URLs in a column** (one per column or `|`-separated, in order): after the listing is
     written, a background step downloads each URL server-side (http(s) only, no private IPs,
     max 15 MB, images only, 30 per listing), stores it in Supabase Storage like an upload, and
     records per-photo status. A listing is created even if some photos fail; failures are
     listed with Retry.
   - **A zip of images** named by listing id or address: uploaded to private Storage, matched by
     file name in the dry run (unmatched files and listings with no photos reported).
   - **A Google Drive folder:** not without widening the Drive scope — out unless the client has
     no other way (open question 5).
9. **Processing 3,000 rows within serverless limits.** Chunks of ~100 rows: each chunk geocodes
   (network, before any transaction), then writes its rows in one transaction, then records
   each row's result. A chunk runs per "continue" request from the open page and on every cron
   tick, so it finishes even if the tab is closed; one chunk at a time per import
   (`FOR UPDATE SKIP LOCKED` claim on the import row). Progress bar from the counts. Photos run
   after, in their own chunks. A full 3,000-row import is minutes, not one request.
10. **Google Sheets: only the picked file.** Provider `google_sheets` with scope
    `drive.file` (+ `openid email`) — the app can open only files the person explicitly picks
    in the **Google Picker** (or files it created); never `spreadsheets.readonly`, never all of
    Drive (ADR 0020 decision). The Picker runs in the browser and needs an access token: the
    server mints a short-lived **access** token for that one call from the stored grant (the
    refresh token never leaves the server; a `drive.file` token can reach only picked files).
    After picking, the server reads the chosen tab with the Sheets API `values.get` and the job
    proceeds exactly as a CSV. "Re-import" re-reads the same file id. Sheets per user, else the
    agency's (ADR 0020's order).

## What we need from the client (exact list)

1. A **real export** of at least 30 rows (anonymised is fine), in the format they will really
   give us — including sold, leased, rental, land, unit (`2/14 Smith St`), and rows with
   missing fields.
2. **The column list with meanings**, and which columns are always filled.
3. **Encoding and format**: UTF-8 or not, delimiter, date format (`DD/MM/YYYY`?), whether
   numbers include `$` and commas.
4. **Prices**: how a price range, "Contact agent", "Offers over", auction and a withheld sold
   price appear.
5. **Status values** they use (e.g. "Current", "Under Offer", "Sold", "Leased", "Withdrawn"), and
   which of their statuses should become **live** here.
6. **Agents**: how a listing's agent is identified (email is best) and what happens when that
   agent is not on the platform yet.
7. **Their own listing id** column, so a second import updates instead of duplicating.
8. **Photos**: URLs (public? permanent or expiring links? order? captions?), a zip, or a Drive
   folder; how many per listing; floor plans separately or mixed in.
9. Inspections / auction times, if they want those imported too.
10. Whether **sold history** (sold price and date) should come in, and for how many years back.

## Permissions (all through `can()`)

- `listing_import:create` — any active member who is not read-only (agent imports are pending).
- `listing_import:read` — its creator, or an admin.
- `listing_import:run` — its creator, after the dry run; `mode = live|draft` requires
  `listing:publish` (owner/admin), else it is forced to `pending`.
- `listing_import:cancel` — its creator or an admin.
- Each created listing passes the same checks as `createListing`; approval of pending ones is
  the existing `listing:publish`.
- `integration:manage` / `integration:use` for `google_sheets` (ADR 0020).

## When something is not connected

- **CSV** needs no integration.
- **Google Sheet** without a usable `google_sheets` account: the "Import from Google Sheets"
  button shows **Connect Google Sheets first** with the Integrations link; expired → "Reconnect".
  The assistant (later) answers the same and proposes nothing.
- **Geocoding key missing** (`GOOGLE_MAPS_API_KEY`): the dry run stops with "Address lookup is
  not set up on this server" before any row is processed.

## Failure cases

| Case | What happens |
|---|---|
| Tab closed mid-import | Cron continues the chunks; the page shows progress when reopened. |
| Process dies mid-chunk | The chunk's transaction rolls back; rows stay `valid`; the next run redoes that chunk (row status makes it idempotent). |
| Same file uploaded twice | File hash matches an earlier import → "You imported this file on <date>"; continue only by choice, and duplicates then catch every row. |
| Geocoding quota hit | Chunk stops before writing; import pauses "Address lookup limit reached — resumes automatically" and retries next tick. |
| Agent suspended during their import | Next chunk refuses (`can()`), import `failed` with the reason; written rows stay pending for an admin. |
| Photo URL 404 / huge / not an image | Listing kept; that photo `failed` with the reason; Retry. |
| Mapping changed after a dry run | The dry run is invalidated; must run again before Import. |
| Sheet edited between dry run and import | Import re-reads and re-validates each chunk; changed rows that now fail are reported, not imported. |

## Tests to write

- Unit: header auto-mapping; value maps; strict price parse (accepts "$850,000", refuses
  "$1.2m"); `price_display` always kept; enumerations refused when unmapped; external-id upsert.
- Unit: chunk worker never geocodes inside a transaction (fake db asserts no open tx during
  the geocode call); idempotent re-run of a chunk.
- Smoke (rolled back, fake geocoder, fake Sheets/Picker): a 300-row fixture with known errors
  and duplicates → the dry run report matches the expected counts row by row; admin Live
  import makes live listings; agent import makes `pending` ones visible to the admin's
  approvals; a duplicate on an active listing is skipped; another agency's listing on the same
  property is not a duplicate; agency B cannot read A's import; a 3,000-row fixture completes in
  chunks within the time budget; Sheets reads only the picked file id.
- Permission tests for `listing_import:*`.
- **Break-tests:** let an agent choose `live` → red; geocode inside the transaction → red; skip
  the duplicate check → red; parse price text at query time → red; widen the Sheets scope to
  `spreadsheets.readonly` → red (a test pins the scope list).

## Open questions (recommended answer first)

1. **Owner/admin default mode** — *Live, with Draft one click away*, as ADR 0024 decided; agents
   always pending.
2. **Max rows per file** — *5,000*, beyond that split the file.
3. **Duplicate on an active listing** — *Skip by default; "Update from file" as an admin
   option*.
4. **Agent named in the file but not on the platform** — *Import with the importing admin as
   listing agent and flag the row ⚠ "Agent not found: x@y"*; the admin reassigns later.
5. **Photos from a Google Drive folder** — *No* (it needs a wider Drive scope); ask for URLs or
   a zip.
6. **Keep the uploaded CSV for** — *30 days after the import finishes*, then delete.
7. **Imported listings' publish date** — *the file's listed date if mapped, else the import
   time*, so days-on-market stays meaningful.
8. **Sold history** — *import sold rows as `sold` listings with price and date* so property
   history and the Sold value widget (ADR 0027) include them.

## Decided (2026-10-06)

- **Q3 (the user): skip** a row whose property already has one of the agency's active listings
  (draft / pending / live / under offer); an **admin-only "Update from file"** option updates
  that listing from the row instead.
- **Client: "make the sample CSV yourself, matching how a listing is created today."** The
  template below is derived from the console's listing form contract
  (`createListingInputSchema` = `propertyDraftSchema` + `listingDraftSchema` +
  `agentUserIds`, `soldDetailsSchema` for sales; `packages/core/src/listings/listing-schema.ts`).
  It is in `docs/import/listings-template.csv` with three example rows. "What we need from
  the client" above is answered by this template; the photo format is **links** (below).
- **Accepted as recommended:** Q1 (admin default Live, Draft one click away; agents always
  pending), Q2 (max 5,000 rows), Q4 (an agent email not on the platform → the importing admin is
  listing agent and the row is flagged ⚠ "Agent not found"), Q5 (photos by **links**, no Drive
  folder), Q6 (uploaded file kept 30 days), Q7 (`listed_on` → `published_at`, else the import
  time), Q8 (sold history comes in as sold listings with price and date).

### The CSV template (UTF-8, comma-separated, header row required)

| Column | Required | Format / allowed values | Goes to |
|---|---|---|---|
| `external_id` | recommended | the agency's own listing id, unique per agency | import row → re-import updates |
| `unit` | no | e.g. `2` (for `2/14 Smith St`) | property.unit |
| `street_number` | yes* | e.g. `14`, `6E` | property.street_number |
| `street` | yes* | e.g. `Smith Street` | property.street |
| `suburb` | **yes** | e.g. `Pakenham` | property.suburb |
| `state` | **yes** | NSW VIC QLD WA SA TAS ACT NT | property.state |
| `postcode` | **yes** | 4 digits | property.postcode |
| `property_type` | no | house apartment unit townhouse villa duplex studio acreage land rural other | property.property_type |
| `bedrooms` / `bathrooms` / `car_spaces` | no | whole numbers (bathrooms may be `1.5`) | property |
| `land_area_sqm` / `building_area_sqm` | no | number, square metres | property |
| `year_built` | no | 4 digits | property.year_built |
| `channel` | **yes** | `sale` or `rent` | listing.channel |
| `status` | **yes** | `live` `under_offer` `sold` `withdrawn` (`draft` also accepted) | listing.status — an admin's **Draft** import makes every row draft; an **agent's** import makes every row `pending` |
| `headline` | **yes** | up to 200 characters | listing.headline |
| `description` | no | text; quote it if it has commas or line breaks | listing.description |
| `price_display` | sale: one of the three | text a buyer reads — must contain a letter or `$` (`Offers over $700,000`, `Contact agent`) | listing.price_display |
| `price_from` / `price_to` | sale: one of the three | whole dollars, no `$` or commas (`700000`) | listing.price_from / price_to (#6: both kept) |
| `rent_pw` | **rent: yes** | whole dollars per week | listing.rent_pw |
| `available_from` | no | `YYYY-MM-DD` | listing.available_from |
| `auction_at` | no | `YYYY-MM-DD HH:mm`, agency time zone | listing.auction_date |
| `listed_on` | no | `YYYY-MM-DD` | listing.published_at (else import time) |
| `sold_price` | **sold: yes** | whole dollars, above 0 | listing.sold_price |
| `sold_date` | **sold: yes** | `YYYY-MM-DD`, not in the future | listing.sold_date |
| `agent_emails` | no | one or more platform members' emails, `;`-separated, first = lead agent | listing_agent (else the importer) |
| `photo_urls` | no | `https://` links separated by a pipe (`\|`), in display order, first = main photo, max 30 | media, downloaded after the listing is written |

\* A row with no street (e.g. vacant land "Lot 12") needs `street` with the lot description;
the address must still geocode, or the row is ✗ "Check the address". Dates are always
`YYYY-MM-DD`, so `03/04/2026` is never guessed.
