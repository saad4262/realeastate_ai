# 0024 — CSV / Google Sheet listings import (PLANNED — not built)

**Superseded by ADR 0029 (2026-10-06)** — its decisions stand and are carried there with the design.

**Status:** decisions from the client/PM, 2026-10-05. Nothing built. Phase 7. Waiting for
the client's **sample CSV** and the **photo format** (URLs in a column? a zip? a folder?).

**Decision.**
1. **Who imports, and what happens to the listings:**
   - an **owner/admin** import goes **live directly**, with an option to import as
     **draft** instead;
   - an **agent** import goes through the existing **submit-for-approval** flow
     (ADR 0014): their rows arrive as `pending`, and an admin approves them.
2. The import is a job with one row per CSV line: validate every row, show a preview with
   every error and every duplicate (matched to an existing property by address key /
   place id, ADR 0013), and only then import — in batches, geocoding before any
   transaction (through `place_cache`), each row's result recorded.
3. Google Sheets: the same job, reading only the one sheet the person picks
   (`drive.file`, ADR 0020's least-privilege rule).
4. The column spec is derived from the listing + property form/schema once the sample
   CSV arrives; it will be written into this ADR.

**Waiting for.** The sample CSV; the photo format.
