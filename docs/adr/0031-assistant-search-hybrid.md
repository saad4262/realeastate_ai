# 0031 — Assistant search over notes, emails and enquiries (hybrid)

**Status:** ACCEPTED, 2026-10-07 (decided by the user: hybrid). Open questions for the client
at the end; the safest default is built meanwhile.

**Context.** The console assistant (ADR 0025) answers from structured rows only. People
want to ask what was *said*: "which buyer asked about a house with a pool in the last six
months?". The words live in three places, all agency-scoped:
- **notes**: `note.body` (soft-deleted by `deleted_at`; `is_private` = author + admins);
- **emails**: `mail_message.text` (in and out), grouped in `mail_thread` (lead or contact);
- **enquiry messages**: `lead.message`, written on the website form (offers are `kind = 'offer'`).

They grow every day, so the search must use indexes, not scans.

## Decision

1. **Full-text first, always on, no key.** Each of the three tables gets a generated
   `search_tsv tsvector` column (`to_tsvector('english', …)`, Postgres keeps it current on
   every insert and update — no application write path changes) with a GIN index. Queries use
   `websearch_to_tsquery('english', …)` and `ts_rank_cd`.
2. **Embeddings second, off by default.** `pgvector` (on Supabase: the `vector` extension in
   schema `extensions` — Dashboard → Database → Extensions, or `create extension if not exists
   vector with schema extensions`) and a table `search_embedding` (agency_id, source_kind,
   source_id, contact_id → contact ON DELETE CASCADE, chunk_index, content_hash, model,
   `embedding vector(1024)`), HNSW cosine index, RLS on. On only when `EMBEDDINGS_PROVIDER`
   is set (`voyage`, with `VOYAGE_API_KEY`); otherwise search is full-text only — never an error.
   Results from both are merged by reciprocal rank fusion.
3. **Model:** Voyage `voyage-4` (1024 dimensions, US$0.06 / 1M tokens, first 200M tokens free —
   checked 2026-10-07). Documents are embedded with `input_type: document`, the question with
   `query`.
4. **Chunking:** about 1,200 characters per chunk with 150 overlap, at most 8 chunks per source;
   an inbound email's quoted earlier reply is stripped first (it is already indexed as its own
   message). `content_hash` = md5 of the source text: a changed note is re-embedded, an
   unchanged one never.
5. **When:** never on the write path (no network inside a request or transaction). The cron
   tick (`/api/cron/alerts`, `CRON_SECRET`) embeds a small batch of new or changed sources and
   prunes embeddings that are no longer allowed; `pnpm --filter @repo/ai search:backfill` runs
   the same batches until nothing is left (with the same caps).
6. **Through `packages/ai`, metered.** The embedding client lives in `packages/ai`; core only
   sees an `Embedder` port. Every call writes `ai_run`: indexing under feature
   `search_embedding` (per agency, its own small cap `EMBEDDINGS_DAILY_BUDGET_USD_PER_AGENCY`,
   default 0.25, inside the global `AI_DAILY_BUDGET_USD`); the question's embedding under
   feature `assistant` for that person and agency — inside the assistant's $1 / $10 caps. A
   full-text-only search is logged too (model `postgres-fts`, cost 0). Over a cap: full-text only.
7. **Permission inside the query, never after.** The WHERE of every search reuses the screens'
   own rules: `visibleContactIdsSql` + `noteVisibleSql` for notes (private notes: author and
   owners/admins), `threadScopeFilters` for emails, `leadScopeFilters` for enquiries (offers:
   owners/admins). Always the actor's agency. Archived and merged contacts are excluded unless
   the person names that contact. A removed member has no agency, so no search at all.
8. **What is never sent to the embedding provider** (it stays searchable by full-text, inside
   our database, for whoever may read it): private notes, deleted notes, anything of an
   archived contact or one who opted out of email, private offers (offer leads and their
   threads). The tick deletes an embedding as soon as its source stops qualifying.
9. **Output:** at most 8 results; each is a contact reference (`C…`), the kind, the date and a
   snippet of at most 200 characters — never the full text, never an address or id.
10. **Prompt injection.** Snippets are other people's words. They are returned only under
    `untrusted_snippet`, with a notice that they are data and never instructions; the system
    prompt (assistant@v6) says the same; no tool acts on text — tools take references, and every
    change is still a card the person approves (ADR 0025).
11. **Offboarding and deletion (ADR 0030).** Notes stay with the agency (private ones readable by
    admins). Removing a member also deletes any embedding derived from their private notes —
    none exist under rule 8, but nothing of their private writing may survive in a derived index
    if that rule ever changes. Deleting a contact deletes its embeddings (cascade).

## Open questions for the client (safest default built)
1. **May note and email text be sent to Voyage AI (a US company) to make embeddings?** Default:
   off (no key set). Needs their privacy policy wording and a data-processing agreement first.
2. **Embed private notes?** Default: no (full-text only, for author and admins).
3. **Contacts who opted out of email — embed their conversations?** Default: no.
4. **Archived contacts in a general search?** Default: only when the contact is named.
