# 0064 — Commissions on deals, and the Finance page

**Status:** accepted, 2026-10-27 (the user reviewed `docs/mocks/commissions.html` and decided four points).
ROADMAP Phase 2.2. Columns on `deal`, in migration 0068 (not yet applied, so the deal tables and these
columns go in together).

**Context.** The brief's #16 and #22 want expected and completed commission, by agent, office, suburb and
property type, live; `/finance` was a placeholder. Deals now exist (ADR 0063).

**Decision.**
1. **The agency sets the commission** (the user, decision 1): on the Deal tab's Commission panel, owners and
   admins (`deal:commission`) choose a percentage of the sale price or a fixed fee, and the agent's share.
   The deal's agent sees it and cannot change it. Nothing comes from Xero yet (Phase 5).
2. **Amounts excluding GST; GST on its own line** (decision 2): commission, GST at 10%, the vendor's invoice
   including GST, the agent's share and the agency's.
3. **The agent's share defaults to their profile's split** (Agents & Team, set at invite), and the agency may
   change it for one deal (decision 3). One agent per deal for now.
4. **One SQL expression works every amount out** (`COMMISSION_SQL`), read by the Deal tab and the Finance page
   alike, so they always agree: commission = round(price × rate ÷ 100, 2) or the fixed fee; agent's share =
   round(commission × split ÷ 100, 2); agency's share = commission − agent's share (so the two always add up);
   GST = round(commission × 0.1, 2). Numbers come from SQL and code, never a model (#4).
5. **Three states**: **Expected** — a deal under contract (Contract or Settlement stage, open) with a
   commission set; **Earned** — settled, counted in the period its settlement date falls in; **Paid out** — the
   agency marked the agent's share paid (`commission_paid_on`), counted in the period of that date.
6. **The Finance page**: periods this month, this quarter, the Australian financial year (July–June) and the
   last one (decision 4), on the agency's clock. Four tiles (earned, expected, the agency's share earned, paid
   out) and one table grouped by agent, suburb, property type or deal. Owners and admins see the agency
   (`report:read_agency`); everyone else sees "My commission": their own deals and share only.

**Not done.** Offices (the agency has no office field on deals yet); splitting between two agents; Xero;
trust accounting (stays in the agency's trust software); commission measures on AI dashboards (next).
