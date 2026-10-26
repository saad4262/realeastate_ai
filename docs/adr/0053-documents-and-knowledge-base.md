# 0053 — Documents and the agency knowledge base

**Status:** accepted, 2026-10-26. Built on `feat/documents` (migration 0061).

**Context.** The brief's #13 (Digital Documents) and #11 (Agency Knowledge Base): contracts,
reports, photos and the agency's own procedures, stored against a contact or a property, and the
assistant able to answer from what is inside them. Until now the assistant read only SQL rows,
and an inbound email's attachments were listed but never kept (ADR 0016 "Not done").

**Decision.**
1. **`document` is one table, two scopes.** `record` hangs off a contact (`contact_id`) and/or a
   listing's property (`listing_id`, `property_id`); `knowledge` belongs to the agency as a whole.
   Files live in a PRIVATE Supabase bucket (`SUPABASE_DOCUMENTS_BUCKET`, default `documents`),
   keyed `documents/<agencyId>/<uuid>.<ext>` — never a URL in a row, never a public read.
2. **Upload is the photo flow (ADR 0009):** can() → a signed upload URL for a key the server chose
   → the browser PUTs to storage → the server HEADs the object and only then writes the row.
   Download is a 60-second signed URL handed out by a route that asks the same rule as the list.
3. **Who sees a document — one SQL rule (`documentScopeFilters`), the same as can():**
   knowledge → every member (`knowledge:read`); a record → owners/admins, its uploader, and —
   unless it is private — whoever may read its contact, or is named on its listing. Upload:
   `document:upload` (= `note:create` on the contact), `document:upload_listing` (= `listing:edit`),
   `knowledge:manage` (owners/admins). Delete: `document:delete` (uploader or admin, like a note).
   An attachment from an offer's thread, or from mail to the agency address, is private.
4. **Reading is a cron job, never a request.** `runDocumentTick` (`/api/cron/documents`, every 5 minutes,
   `maxDuration` 300) claims pending
   documents with `FOR UPDATE SKIP LOCKED`: PDF text layer with `unpdf`, `.docx` with `mammoth`,
   plain text as is. A scanned PDF (under ~40 characters a page) or a photo goes to the vision
   reader in packages/ai (Claude, `document-read@v1`, metered in `ai_run`, refused once the daily
   AI budget is spent). Text is stored per page (`\f` between pages).
5. **Chunks are their own table (`document_chunk`)**, not `search_embedding`: a document answer
   needs the chunk's own text and its pages for a citation, and documents are hundreds of chunks
   where a note is one. Each chunk has a generated `tsvector` (full-text always) and a nullable
   voyage-4 vector (when embeddings are on and the agency is under its indexing cap).
6. **Two read tools for the assistant:** `search_documents` (hybrid, through the visibility rule,
   returns `D` references with page numbers and untrusted snippets) and `read_document` (pages of
   one document it was given). Document text is DATA (the ADR 0031 untrusted-snippet notice):
   nothing in a document is an instruction, and no tool acts on document text.
7. **Inbound attachments** (ADR 0016's gap): the tick lists a received email's attachments from
   Resend (`GET /emails/receiving/{id}/attachments`), downloads PDFs, images, Word and text files
   (not inline images), stores them as `record` documents on the thread's contact, and marks the
   message `attachments_stored_at` so it is tried once.
8. **Non-negotiable 4 still holds.** A figure read off a contract is text in a document, shown
   with its page; it never becomes a price, a date or a status in SQL without a person.

**Not done.** E-signatures, versions, folders; a property page of its own (property documents sit
on the listing's edit page); OCR of a scanned PDF over 20 MB or 100 pages (marked failed, says
why); re-reading when the vision model changes; documents in workflows and dashboards.
