# 0093 — Agency closure: export, then deletion 30 days later

**Status:** accepted 2026-11-19 (PLATFORM-PLAN 5.12; ADR 0030 §5 asked for this before the first agency leaves).

**Closing.** An owner asks; a platform operator runs `closeAgency`: the agency is suspended (nobody signs in, nothing
sends) and an `agency_closed` audit row records when. Nothing is deleted yet: an agency that changes its mind is
un-suspended.

**Export** (any time, and always before deletion). Every row of every table with an `agency_id`, and the rows of
their child tables, as one JSON-lines file per table, plus the agency's document files. Not exported:
- secrets: invite tokens, OAuth tokens, Twilio keys (the columns are dropped);
- other people's data that hangs off the agency's rows: a buyer's shortlist, inspection notes, property watches,
  the public guide's chats, consumers' read receipts, site browsing;
- platform records and derived data: jobs, platform admin logs and mail, AI query tickets and holds, embeddings
  and document chunks (rebuilt from the documents).
The table lists are code, and a check fails when a new table is neither exported nor excluded.

**Deletion** (`deleteAgency`, by script, refused unless the agency is suspended and was closed at least 30 days ago).
One transaction:
1. Its listings move to a platform "archived listings" agency: live ones are withdrawn, agent links removed. A
   listing is not deleted, because a buyer's shortlist and inspection notes, and the address's sales history, hang
   off it (ADR 0012: an agency must never be able to cascade those away).
2. The agency row is deleted; every agency table cascades (60 tables), and three keep their row with the agency
   emptied (AI cost, site activity, platform mail).
After the commit its document files are deleted from storage; a file that fails is reported for a re-run.
Members' own accounts stay (a person may work elsewhere or delete their own account).

**Owner decision (D-5.12):** keeping archived listings is the default. If the owner prefers sold history to go
too, step 1 deletes them instead, and buyers lose those shortlist entries and notes.
