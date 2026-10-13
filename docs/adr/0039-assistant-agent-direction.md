# 0039 — The assistant as an agent: direction and decisions

**Status:** ACCEPTED, 2026-10-13 (the user, after the read-only audit of 2026-10-13). Sets the
order of work and four decisions that later ADRs build on. Nothing here is built by this ADR.

## Scope

- **V2, not now:** scraping social media for leads (the "advanced lead" skill).
- **Cost:** the assistant is not held back by cost. The caps stay in code as configuration
  (`AI_DAILY_BUDGET_USD`, `ASSISTANT_DAILY_BUDGET_USD_PER_USER`, `…_PER_AGENCY` in
  `core/src/assistant/budget.ts`); the user raises them per environment.

## Order of work

1. **Phase 1 — stabilise:** the model is told what happened to its cards (approved, rejected,
   done, failed, expired) at the start of the next turn; a single email is sent at most once
   (claim before the provider call, a sweeper for stuck rows).
2. **Phase 2 — full CRM and multi-step tasks:** a persisted task with steps (its own ADR),
   reminders, contact/lead/agent/listing tools as cards, bulk email on lists and saved
   filters, "connect X first" everywhere.
3. **Phase 3 — Google Sheets and file ingestion** into contacts and listings, previewed and
   approved, through the CSV import pipeline (ADR 0029).
4. **Phase 4 — dynamic dashboards, skills and workflows** from plain language: specs from a
   catalog, compiled and run as the person — never model-written code or SQL (ADR 0036's pattern).

## Decisions

**A — Nothing is deleted for good.** "Delete" from the assistant (or any new screen) is:
contact → **archive** (reversible); lead → **close** (status `closed`); agent → **remove**
(offboarding, ADR 0030, 30-day undo); listing → **withdraw** (a draft may still be deleted
where `deleteListing` already allows it). Records and consent history are kept.

**B — Google: whole-app access, and uploads.** Sheets may read any sheet the person can open
(a pasted link works), not only a file picked with Google Picker. This **amends ADR 0020's
least-privilege decision** for Sheets. Consequence, to plan for: the read-all scopes
(`spreadsheets.readonly` / `drive.readonly`) are Google *restricted* or *sensitive* scopes —
verification needs a domain, a privacy policy and, for restricted scopes, a third-party
security assessment, and tokens of unverified apps expire after ~7 days. Exact scope names and
review requirements are checked against Google's documentation when Phase 3 starts. The person
may also **upload a file in the assistant** (CSV/XLSX) and ask for it to be imported.

**C — Who sees which lead.**
1. An agent sees the leads (and their conversations) **assigned to them or made on a listing
   they listed**. Nothing else of other agents'.
2. The agency (owner/admin) sees everything, in full detail.
3. A new lead on Saad's listing is **assigned to Saad automatically** (the listing's lead
   agent). If the agency reassigns it to Ahmed, it **stays in Saad's list** but read-only, with
   the line *"This lead is now with another agent. You can no longer change it — contact your
   agency for more information."*

As of today (verified 2026-10-13): reading is already "assigned to me or on my listing"
(`permissions.ts` `lead:read`, `leads/list-leads.ts` `leadScopeFilters`) and changing is
already the assignee only (`lead:update`). **To build:** the automatic assignment at creation,
and the read-only line (screens and the assistant's refusal).

**D — Agents have their own powers over their own data.** An agent may save their own
dashboards and use their own skills/workflows, always computed over what they may see; they
can never reach agency-wide figures. The agency (owner/admin) has every power. This amends
ADR 0027 / 0036 Q1 (only admins saved dashboards).

## As built — Phase 1 (2026-10-13, branch `feat/assistant-phase1`; migration 0046 applied on dev)

- **The model knows how its cards ended.** `core/src/assistant/card-updates.ts`:
  `takeCardUpdates` marks each card that ended (done, failed, rejected, cancelled, expired —
  a `proposed` card past its expiry counts as expired) `reported_at` and returns it, lists the
  scheduled ones (told every turn until they run) and counts those still waiting;
  `cardUpdatesBlock` writes the `<card_updates>` block (titles quoted as data, the console's own
  reason and run notes, never ids or arguments). The pipeline puts it between
  `<console_context>` and the person's words; a turn that fails, is refused for budget or is cut
  off calls `unreportCards`, so the next turn tells it again. Read tool **`check_cards`** lists
  them all. Prompt **`assistant@v14`**.
- **One email, once.** `mail/send.ts` `deliverOutbound`: a guarded claim
  (`send_started_at`, `queued` only, free or older than 10 minutes) BEFORE the provider call — a
  second delivery gets `sending` and sends nothing; Resend gets `Idempotency-Key:
  mail-message-<id>-<attempt>` (Resend keeps keys 24 h; same key + same body = one email —
  checked in Resend's docs 2026-10-13), so a crashed send taken over is not doubled; a crashed
  send that went through **Gmail** (no key there) is never resent — failed, "check the Sent
  folder"; a 409 `invalid_idempotent_request` becomes "may already have been sent". A person's
  Retry is a new try (`send_attempt + 1`, a new key). `resendStuckMessages` in the 5-minute tick
  delivers messages left `queued` (not template email, which has its own recovery).
  `SendOutcome` gains `sending`; the template sender leaves such a recipient for its recovery;
  the assistant card says "Being sent".
