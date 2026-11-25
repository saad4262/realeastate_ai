# 0101: Smart search: rules first, AI only for what rules cannot read

**Status:** accepted 2026-11-25. The user asked for realestate.com.au-style AI search and approved a mix of rules and AI.
Research notes are in SESSION 2026-11-25.

- **One box, no switch.** A sentence such as `pakenham 10km 3 bed house under 800k` is read by `parseSearchText` in
  packages/core: plain rules, on every keystroke in the browser, with no request and no model.
  It reads distance, beds, baths, cars, price, property type, rent/sale and "new". What is left over is the place text.
- **Set, then search.** The parse is offered as the top option in the dropdown. Picking it sets the chips, Distance and
  Filters. Searching stays a separate step, so the user sees exactly what will be searched.
- **AI only on leftovers** (part 2). It runs when the rules' places are not places, or on Search with a sentence of
  three or more words that matches no suburb. It is `POST /api/search/understand`, using `skill-summary` (Haiku).
  The model fills the search's own fields, plus two lists:
  - keywords: matched in the listing headline or description, `kw`, every one required;
  - "not searchable" asks, shown and never searched.
  - Every number must appear in the user's own words, and a number the rules read wins.
  - A keyword or a "not searchable" ask must be words the user typed.
  - Places go back to the server's geocoder, so the model never supplies coordinates.
  - Calls go through `aiBudgetAllows` and `ai_run`. There is a per-IP and a daily limit, a day's cache per sentence,
    and a 4 s timeout. On any failure the box searches as before.
  - `SEARCH_AI=off` turns the model off.
- **Refining** is the same box above the results: "make it 4 bed" or "add clyde" changes the search in place.
- **Honest gaps.** Schools and travel time have no data here. They are shown as "not searchable yet", never guessed.
  Results are always SQL.
- **Not done:** travel-time search, because it needs a paid routing API.
