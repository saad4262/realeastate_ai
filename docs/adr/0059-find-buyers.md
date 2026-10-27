# 0059 — The assistant finds buyers whose brief fits a property

**Status:** accepted, 2026-10-27. ROADMAP Phase 1.3. No migration.

**Context.** The brief's own example for #21, "find buyers looking for a 3-bedroom house in Pakenham under
$800,000", could not be answered: buyer briefs (ADR 0055) were read only by the hourly `buyer_match`
detector, and the assistant had no tool over them.

**Decision.**
1. **A read tool, `find_buyers`.** It takes either a listing (a P reference from find_listings) or a
   property in words — sale or rent, suburb, a price ("under $800k" → `price_to`, "from $700k" →
   `price_from`, "around $750k" → both), bedrooms, bathrooms, type. Never both.
2. **The same rule as the matcher, from the property's side:** a brief fits when the property would suit
   it — same channel; the price ranges overlap (a missing bound on either side is open); at least the
   brief's bedrooms and bathrooms; its suburb in the brief's suburbs and its type in its types, an empty
   list meaning any. Active briefs only, on contacts the person may read (`visibleContactIdsSql`), never
   archived or merged. A listing whose price is not stated is searched without the price, and the answer
   says so — unlike the alert, a person asking can judge it.
3. **Transparent** (#21): the result and the panel say what was searched for, in the words the
   Requirements tab uses (`describeRequirement`), and each buyer's brief beside their name. The brief's
   free-text note is never sent to the model. In listing mode, a buyer who already enquired on it is marked.
4. **Not gated by a skill switch**: it reads only what the person may already open; Buyer matching
   (ADR 0058) switches the alerts, not looking.
5. One row per brief (a contact with two fitting briefs shows twice), briefs naming a suburb first, then
   the most recently changed; 20 by default, at most 50. Prompt v27.

**Not done.** Emailing or tasking the found buyers from the result (ROADMAP 1.4); briefs without a suburb
ranked by distance; buyers in other agencies.
