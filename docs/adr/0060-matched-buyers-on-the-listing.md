# 0060 — Matched buyers on the listing, emailed or called from there

**Status:** accepted, 2026-10-27 (the user reviewed `docs/mocks/matched-buyers.html` and decided four
points). ROADMAP Phase 1.4. Migration 0066.

**Context.** The assistant can list the buyers whose brief fits a listing (ADR 0059), and an agent is
alerted when a new listing fits (ADR 0055 §6). The brief's #5 wants the next step: from the listing,
see those buyers and email, text or call them. SMS waits for Phase 3.

**Decision.**
1. **The listing's edit page becomes tabs** (the user, decision 1), in the URL as `?tab=`: Details (the
   form), Photos, Documents (ADR 0053's panel), Matching buyers. Offers and more fit in later. Both
   consoles: `/live-listings/[id]/edit` and `/listings/[id]/edit`.
2. **Matching buyers uses find_buyers' rule from the listing's figures** (ADR 0059 §2), on contacts the
   person may read. One shared SQL predicate serves the tab, the Listings table's new **Buyers** column
   (counts for the page's listings in ONE query, never one per row) and the assistant, so the three
   always agree. A listing with no price is matched without the budget, and the tab says so.
3. **Each buyer shows whether they can be emailed**, by the bulk-email rule itself (ADR 0043's consent
   and `classify`): recorded consent, an enquiry in the last 24 months, or a client role; unsubscribed,
   archived or no email is shown with its reason. **The checkbox is off for anyone who cannot be emailed**
   (the user, decision 4: the strict Spam Act reading — a brief alone is not consent).
4. **Email selected → pick a template → Prepare & review → the existing batch page → Approve & Send.**
   Nothing new sends: `prepareBatch` with the picked contacts, so consent, the opt-out, the 20-per-batch
   limit, the daily limits and the Bulk email switch (ADR 0058) all hold.
5. **Three listing merge fields** (the user, decision 2): `{{listing_address}}`, `{{listing_price}}`,
   `{{listing_link}}`. A template may use them; they are filled only when the batch is prepared from a
   listing. The values are **frozen into the batch at Prepare** (`email_batch.listing_id`,
   `listing_snapshot`) like the template is, so what the agent reviewed is what is sent even if the
   listing changes. A template that uses them is refused anywhere without a listing (the bulk-email
   page, the assistant, workflows), and `{{listing_link}}` is refused for a listing that is not live —
   it has no public page. Values come from SQL, never a model.
6. **Remind me to call → ONE task** (the user, decision 3): "Call 5 matched buyers for 27 Lakeside
   Boulevard" at 9 am tomorrow on the agency's clock, its note listing each buyer with their phone. It is
   an assistant task with one `remind` step (the same machinery as create_reminder): one notification,
   never one per buyer. At most 20 buyers in one.

**Not done.** SMS and calling from here (Phase 3); choosing the reminder's time; buyers from other
agencies; an Offers tab.
