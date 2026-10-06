# 0023 — Google reviews: business-level, in two steps (PLANNED — not built)

**Superseded by ADR 0028 (2026-10-06)** — its decisions stand and are carried there with the design.

**Status:** decisions from the client/PM, 2026-10-05. Nothing built. Phase 6.

**Context.** The client wants the agency's Google rating and reviews in the console, on
agency and agent profiles, and tied to contacts where that is certain.

**Decision.**
1. **Step 1 — Places API, with the existing Google key.** The agency's place: rating,
   review count and the few recent reviews the Places API returns, always shown with
   Google's attribution as its terms require. **Check the Places API terms on storing
   reviews before building** — if storing is not allowed, cache only what the terms
   permit and re-fetch.
2. **Step 2 — Google Business Profile API** (the `google_reviews` integration, an
   agency-level connection by an owner/admin, ADR 0020) for ALL reviews, once Google
   grants API access.
3. **Business-level only.** Reviews belong to the agency, never to one agent. An agent's
   profile shows the agency's reviews; nothing attributes a review to an agent.
4. **Matching a review to a contact** happens only when an admin presses **Link to
   contact** and picks the person. No automatic matching on names. Until then the review
   shows as **Unmatched**. A linked review appears on that contact's Reviews tab and
   timeline.
5. **Review requests** to contacts go by email with the same preview + explicit Approve as
   every platform email (ADR 0022's rules), counted in the sending limits. **No incentives
   and no review gating** (no asking only happy clients, no "rate us first, then we decide
   whether to send you to Google") — both against Google's policies and the ACCC's.
6. One Google listing per agency for now, modelled as a table so more are possible.

**Not decided yet.** Where the place id comes from (admin pastes it / picks from search).
