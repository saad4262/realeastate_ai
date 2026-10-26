# 0056 — AI help for the contacts import

**Status:** accepted, 2026-10-26. Built on `feat/documents` (migration 0064). Feature 3 of three.

**Context.** The contacts import matched columns by a list of header synonyms and checked rows by
fixed rules; anything else was the uploader's to fix by hand. "Client Name", "E-mail Addr" and
"Mob No." matched nothing, and "SMITH, John", `+61 (0)413-111-222` or `14/11/2026` failed the row.

**Decision.** Two steps, both behind interfaces in core (`imports/contact-ai.ts`: ColumnMapper,
RowCleaner) and implemented in `packages/ai/pipelines/import-assist.ts` (non-negotiable 3).
1. **Mapping, right after upload**, only when a headed column went unused and a field is unmatched.
   Sent: the headings and 5 sample rows **masked** — every letter x/X, every digit 9 — so no one's
   details leave for a mapping. The synonyms' matches always stand; the model only fills fields
   still empty, from columns not yet used; out-of-range or repeated answers are dropped. The fields
   it filled are stored (`ai_mapped`) and marked "✦ AI" on the mapping screen; changing one unmarks it.
2. **Cleaning, opt-in per import** (`ai_clean`, a checkbox, off by default — it sends personal
   details). Only rows that FAIL the normal check, only their mapped name/email/phone/roles/
   assigned-agent/date fields (never a note or an unmapped column), one request per 100-row chunk.
   Every proposed value must pass a guard proving it came from the row — an email's characters are
   in the row, a phone's last 8 digits are, a name's words are, a date's day/month/year are, a role
   only for a cell that said one — and the row is then checked by the same `normalizeContactRow`.
   A model never decides a row is valid. Each change becomes a warning on the row ("Fixed by AI:
   “x” → “y” — check it"), shown in Rows to look at before anything is imported.
3. **Model and cost.** Structured output (`beta.messages.parse` + `betaZodOutputFormat`), field
   names as strings filtered in code (the API takes an enum only as a hint). `ANTHROPIC_IMPORT_MODEL`,
   default Opus 5.5 at low effort, server-side fallbacks; 30 s timeout, one retry. Metered to `ai_run`
   (`import-map`, `import-clean`) under the agency; `IMPORT_AI_DAILY_BUDGET_USD_PER_AGENCY` (default
   $1/24 h) and `AI_DAILY_BUDGET_USD` cap it. Any failure — no key, over budget, an error — leaves the
   import exactly as it would have been without AI.

**Not done.** An address field for contacts (it needs `contact_property` and geocoding);
AI for the listings import; a "suggest again" button; a live-model eval of mapping quality.
