# 0044 — Complex dashboard requests: many parts in one prompt, many datasets in one view

**Status:** ACCEPTED, 2026-10-16 (asked by the user). Builds on ADR 0042 (open questions). The
locks of 0042 (L1–L5) are unchanged.

## Context

The user asked for prompts that ask 9–10 things at once and are answered as one dashboard. The
example was: "a dashboard with agent names, their licence numbers, active listings in specific
suburbs, total sales value this month and their average lead response time, all grouped together."

ADR 0042 already lets the assistant join datasets in its own SELECT. This request still failed
in four places:

1. **Data that was not exposed.**
   - Licence numbers are in `agent_profile`, but the `ai.agent_profile` view (0052) does not
     list them.
   - Lead response time has no dataset. It can be worked out from `emails`, but only by a
     fragile query.
2. **Prompt v21 points complex requests the wrong way.** It tells the model "a tile has one
   dataset; make one tile per dataset", which is the catalog's rule. So "all grouped together"
   was split into separate tiles that cannot line up.
3. **Fan-out.** Joining listings and leads onto agents in one FROM multiplies rows: each agent's
   sales are counted once per lead. The figure looks plausible and is wrong. That breaks
   non-negotiable rule 4 in spirit, even though SQL computed it.
4. **Sizes and budgets.** All of these were set for one question, not ten:
   - a query may be at most 4,000 characters
   - a tile may have at most 16 columns
   - a turn may make at most 20 tool calls
   - a turn may write at most 8,000 output tokens, so a 10-tile `create_dashboard` call is cut off
   - an agency may run at most 60 queries an hour

## Decision

**A — Decompose, then build.** Prompt v22 sets out a procedure for any request with several
parts:

1. List every item asked for.
2. Map each item to a dataset column, or mark it "not held".
3. Choose the layout:
   - one row per agent, or per suburb, for "grouped together"
   - a strip of several numbers for agency-wide totals
   - a line for a trend
4. Build each query and check its rows.
5. Propose the dashboard.

`create_dashboard` takes `coverage`: each item asked for, with the place it is shown, or
"not held". The card shows that list, so nothing the person asked for disappears silently.
When a request spans more than one dataset, the open path comes first; the catalog's
one-dataset tiles are only for single figures.

**B — The data the example needs.**
- `agents` gains `licence_number`, `licence_class` and `licence_expiry`. Migration 0054
  replaces the view and appends those columns to it.
- A new dataset, `lead_responses`, has one row per lead with:
  - `first_reply_at`: our first sent email on any of the lead's conversations at or after the
    lead came in
  - `response_minutes`
  - `replied`
  - `replied_by_agent_id`

  It uses the same lead scope as the `leads` dataset. Phone calls are not held, and the
  dictionary says so.
- A new dataset, `sales`, has one row per sold listing:
  - the lead agent, the price, the date and the suburb
  - `price_disclosed`

  It means "sales value" is `sum(sold_price)` and nobody has to remember `status = 'sold'`.

**C — Fan-out is taught and checked.**
- The dictionary's first rule: aggregate each activity in its own CTE, at the grain of the
  result (per agent, per suburb …), then LEFT JOIN the aggregates onto the base dataset. It
  includes a worked example of a 5-part, per-agent query.
- Code check: a tile with `rows_are: "agents"` whose result names one agent twice is refused,
  with the reason "aggregate per agent first". `query_data` reports the same to the model.

**D — Errors that teach.** When Postgres refuses a query, the error the model receives adds a
hint:
- an unknown column: the columns of the datasets that query used
- an ambiguous column: qualify it with the dataset's alias
- a GROUP BY error: aggregate it or add it to GROUP BY
- division by zero: use `nullif(x, 0)`
- a timeout: aggregate first, in CTEs, over a shorter period

**E — Room for a big request.** Each value is still a cap. None of them is a lock.

| Limit | Old | New |
|---|---|---|
| Query length | 4,000 characters | 12,000 characters |
| Columns per tile | 16 | 24 |
| Tool calls per analysis turn | 20 | 30 |
| Output tokens per analysis round | 8,000 | 32,000 (the history is unchanged, so the cache still holds) |
| Open queries per agency per hour | 60 | 150 |

The 5 s statement timeout, the 500 kept rows and the 50 rows shown to the model stay as they
are. The dev database is the production database.

**F — A tile kind for several figures.** The open tile's `viz` adds `figures`: one result row,
with every numeric column drawn as a labelled figure. This suits headline totals ("Sales this
month · Active listings · Average response").

## Alternatives

- **Remove the parser or the scope CTEs ("no limits").** Rejected. The user asked for owners and
  admins to have full data access, and they already have it through the agency-wide scope. The
  locks are what make model-written SQL safe at all (0042). They restrict whose rows a query
  sees, not how many datasets it joins.
- **Plan the request in a second model call.** Rejected. It costs another call and duplicates
  the decomposition. The model already reasons inside the turn, so the procedure and the
  coverage list are enough.

## Consequences

- **Order matters:** migration 0054 must be applied before this code reads `agents`. Without it,
  every `agents` query fails with "column does not exist".
- The prompt version becomes `assistant@v22`.
- Tests:
  - Unit: L1 accepts a 10-part reference query; the error hints; the duplicate-agent refusal;
    the `figures` tile; coverage lines on the card.
  - Smoke, a new check in "Open questions": the user's example over two agencies, with every
    figure computed by hand, every agent present, and agency B's rows changing nothing.
  - Live behaviour on real prompts is checked only by `pnpm smoke:ai`, run deliberately.

## As built (2026-10-16, branch `feat/complex-dashboards`; migration 0054 APPLIED with the user's permission)

- **Fan-out check, and its limit.**
  - The code catches *ungrouped* fan-out: an agent on two rows of a per-agent result. `query_data`
    reports it, `show_widget` sends the tile back to be fixed, a saved tile shows "needs
    rebuilding", and `create_dashboard` refuses it.
  - It cannot catch *grouped* fan-out: two activities joined, then `GROUP BY agent`. The result has
    one row per agent, and the sums are multiplied. Telling that apart from a legitimate join needs
    the query's meaning, not its shape.
  - That case is held by the dictionary's first rule, its worked example and prompt v22.
  - The smoke check runs the naive grouped query and asserts that its figure differs from the
    hand-worked one, so the expectations would catch the mistake.
- **The worked example is a real query.**
  - The unit test extracts the example from `dataDictionary()` and checks that L1 accepts it.
  - The smoke check runs the same text on the database and compares every figure with the
    values worked out by hand.
- **Model output.**
  - In a turn that has used `describe_data` or `query_data`, each later round may write 32,000
    tokens. This is `max_tokens` only.
  - The effort setting and thinking are unchanged. Raise them only after a measurement.
- **Coverage.** `shown_in` must equal the title of a tile on the dashboard, ignoring case.
  Otherwise the card is refused, and the refusal lists the real titles.
- **Not changed:**
  - Agents still cannot save a dashboard (ADR 0027).
  - The 5 s timeout, and the 500 rows kept for a tile, stay as they were.
  - The parser, the scope CTEs, the role and the views (L1–L5) stay as they were.
- **Tests.**
  - Unit: `open-query.test.ts` has 68 tests, 15 of them new. One checks a real 4,000+ character
    query over 11 datasets and 24 visible columns. `assistant/coverage.test.ts` has 4 tests.
  - Break-tests, both red when broken: the fan-out detector disabled, and the coverage title
    check disabled.
  - Smoke "Open questions": the example over two agencies. Green: every hand-worked figure matched, and the naive grouped
    query gave 3,600,000 where the right figure is 900,000.
  - `pnpm smoke:ai`, in its own group "Many parts, live AI": the example phrase end to end. Green on one run: 4 tool calls,
    1 query, 6 coverage lines with commission not held, and a1's row exact. One sample is not a reliability figure.
