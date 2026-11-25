# 0101: Smart search: rules first, AI only for what rules cannot read

**Status:** accepted 2026-11-25. The user asked for realestate.com.au-style AI search and approved a mix of rules and AI.
Research notes are in SESSION 2026-11-25.

- **One box, no switch.** A sentence such as `pakenham 10km 3 bed house under 800k` is read by `parseSearchText` in
  packages/core: plain rules, on every keystroke in the browser, with no request and no model.
  It reads distance, beds, baths, cars, price, property type, rent/sale and "new". What is left over is the place text.
- **Set, then search.** The parse is offered as the top option in the dropdown. Picking it sets the chips, Distance and
  Filters. Searching stays a separate step, so the user sees exactly what will be searched.
- **AI only on leftovers** (part 2, not built yet). It runs on Search when words remain that neither the rules nor the
  place lookup understood. The model fills only the fields `search_listings` already takes.
  - Every number must appear in the user's own words, and a number the rules read wins.
  - Places go back to the server's geocoder, so the model never supplies coordinates.
  - Calls go through `checkAiBudget` and `ai_run`, with a cache and a fallback to the rules result.
- **Honest gaps.** Schools and travel time have no data here. They are shown as "not searchable yet", never guessed.
  Results are always SQL.
- **Not done:** travel-time search, because it needs a paid routing API.
