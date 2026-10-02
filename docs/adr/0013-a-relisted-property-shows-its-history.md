# 0013 — A re-listed property shows its history, and one address is one property

**Status:** accepted, 2026-10-02. Amends part 2 of ADR 0012; parts 1, 3 and 4 stand.

**Context.** ADR 0012 hid a property's past sales while it was on the market. The
client has asked for the realestate.com.au behaviour instead: a house sold by one
agency and listed again by another shows every earlier sale on the new listing.
That only works if the second agency's listing lands on the SAME property row, and
`upsertProperty` matched the raw address columns, so "6e Henry St" and "6E Henry
Street" were two houses.

**Decision.**
1. `/listing/[id]` renders the property's Timeline (and a Property history tab)
   whenever there is an entry other than itself. `HISTORIC_STATUSES` still gates
   what a visitor may see, so drafts and withdrawn ads stay out.
2. `upsertProperty` matches on `addressKey` (case, spacing, street-type
   abbreviations, unit prefixes, "32/6E" in the number box), among properties in the
   same suburb, postcode and state, oldest first. Folding rules only merge two
   spellings of one thing; a doubtful case stays apart, because two houses merged
   would publish one vendor's price on another's listing. A transaction-scoped
   advisory lock on the key stops two concurrent saves inserting twice.
3. While an address is live, `/property/[id]` redirects to the live listing, and
   `/sold` and the guide link a re-listed sale there ("For sale now"). Under offer
   stays a 404. The private offer still requires nothing on the market, so an
   approach always reaches the agency selling now, never the one that sold last.

**Not done.** Existing duplicate rows are not merged (the dev database has none).
Sales from before this platform (state valuer-general data) are a separate import.
