# 0063 — The deal pipeline: every sale from appraisal to settlement

**Status:** accepted, 2026-10-27 (the user reviewed `docs/mocks/deal-pipeline.html` and chose the four
recommended answers). ROADMAP Phase 2.1. Migration 0068 (to be written).

**Context.** The brief's #14: Appraisal → Listing → Marketing → Offers → Negotiation → Contract → Settlement,
everything together, and the AI able to say where every property is at. Today a listing has only a status
(draft, live, under offer, sold, withdrawn) and a sold price and date.

**Decision.**
1. **Seven fixed stages** (the user, decision 1), in that order. Custom stages per agency may come later.
2. **Sales only for now** (decision 3). A lease has different steps (application, approval, bond, move-in)
   and comes with Property Management (Phase 7).
3. **One deal per listing campaign** (`deal`: stage, sale price, buyer contact, contract date, deposit and
   when paid, settlement date, buyer's solicitor, settled at) and its **conditions** (`deal_condition`):
   the four standard ones — cooling-off, finance approval, building & pest, unconditional — each with a
   due date and a done date, **plus any condition the agent adds** (decision 4). Every stage change is
   recorded (`deal_event`: from, to, when, by whom or "automatic", why).
4. **Stages move by themselves where the platform already knows**: a listing going live → Marketing; a
   first private offer → Offers; "Under offer" → Negotiation; **"Mark sold" → Contract, with the sale price
   and date it records; Settlement is a separate step on the Deal tab** (decision 2, the Australian
   practice: sold at contract, settled weeks later). An appraisal appointment or appraisal lead opens a
   deal at Appraisal; a draft listing is at Listing. A deal never moves backwards by itself; a person may
   move it either way on the Deal tab.
5. **Settle** records the date and final price, closes the deal, and offers to tag the buyer and the vendor
   as Past clients (ADR 0061).
6. **Where it shows**: a Pipeline board under Properties (owner/admin: the agency's; agent: their own
   listings'), with counts — active, under contract, settling in 30 days, a condition due this week — and a
   Deal tab on the listing's page (ADR 0060's tabs). Two days before each condition's due date and the
   settlement date, the listing agent gets a reminder.
7. **The assistant** can answer "which deals settle this month?" from the same tables (a read), as numbers
   from SQL (#4). Commission is Phase 2.2 and is not in this step.

**Not done.** Commission and `/finance` (2.2); the property page with everything (2.3); rentals; custom
stages; e-signing a contract.
