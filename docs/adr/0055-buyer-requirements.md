# 0055 — Buyer requirements

**Status:** accepted, 2026-10-26. Built on `feat/documents` (migration 0063). Feature 1 of three; smart
matching (Feature 2) and AI contact import (Feature 3) follow.

**Context.** A contact could be tagged `buyer`, but nothing recorded what they wanted: budget,
bedrooms, suburbs, type. `lead.ai_qualification` is a model's free text and cannot be matched in
SQL. Feature 2 matches each new listing against these briefs, so they must be numbers a WHERE reads.

**Decision.**
1. **A table, `buyer_requirement`, not JSON on `contact`.** One row per brief; a contact may hold up to
   10 (a home and an investment are two briefs). Typed columns: `channel` (sale | rent, from the
   `listing_channel` enum), `price_min` / `price_max` numeric (per week for rent, as the public
   search reads `rent_pw`), `min_bedrooms` int, `min_bathrooms` numeric(3,1) in halves, `suburbs`
   and `property_types` text[] (empty = any), `note` (never matched), `status` active | paused.
   Carries `agency_id` (isolation group OWN_AGENCY); RLS on, no grants.
2. **The agent's figures, never guessed (#4).** `$850,000` and `850000` are read; `850k` and `1.2m` are
   refused. A brief must say something — one with no bound would match every listing.
   Suburbs are stored in one spelling ("Bondi Beach"), de-duplicated case-insensitively; v1 has
   no state beside a suburb (a Richmond in four states is a known gap for the matcher).
3. **No new permission.** A brief is part of the contact: read with `contact:read` (through
   `ReadableContact`), written with `contact:update` — the assigned agent or an admin, never
   read-only. Each write records `requirement_added | _updated | _removed` on the timeline with a
   summary rendered from the figures (`describeRequirement`), never the note.
4. **Merge moves them** to the survivor, even past the cap.
5. **UI:** a Requirements tab on the contact (count = active briefs), "Looking for" on the overview.

**Fixed on the way.** `approveListings` moved pending → live without a `listing.status_changed`
event, so an approved listing never reached a workflow (and would never have been matched). It
now writes one event per listing that moved, in one insert, in the same transaction
(`emitWorkflowEvents`).

**Not done.** The matcher (Feature 2: an opportunity detector `buyer_match`); an assistant tool to
read or write briefs; capturing a brief from an enquiry; suburb + state.
