# 0036 — Semantic layer for composable dashboards

**Status:** ACCEPTED, 2026-10-12 (decisions at the end, "Decided"). Phase 0 under way. Amends ADR 0027 (the fixed widget library stays;
a new `custom` widget kind joins it) and ADR 0034 (`agent_activity` stays hand-written for
now). Asked by the user (Roman Urdu: "every agency will want mini dashboards for different
things; the assistant can't be trained on each one — how do we handle any request, the way
we ask Claude?").

## Context

ADR 0027 gave the assistant a **fixed widget registry**
(`packages/core/src/widgets/registry.ts`): the model picks a widget id and a range, and every
figure is one hand-written SQL statement. It is safe, but every new request is a code change —
ADR 0034 was exactly that ("all agents and the emails they received today" became a new
widget). With many agencies asking for different views, that does not scale.

Letting the model write SQL or chart code is **ruled out**: one missing `agency_id` filter
shows agency A's data to agency B (ADR 0017, 0030); a wrong join produces a figure that looks
right and is not (#4 exists so a figure can be trusted); and viewer-scoped figures (ADR 0027
§6) cannot be guaranteed in generated SQL.

**The server bypasses RLS.** It connects to Postgres as the table owner and decides with
`can()` (ADR 0017). RLS is a second lock for every other door, not for these queries: a
widget's only protection is the scope predicate core puts in its WHERE clause. Whatever
replaces hand-written widgets is therefore **the only lock** between a viewer and every
agency's rows.

A review of the current widgets (2026-10-12) found the parts a compiler needs, and gaps:

- **Ready:** `leadScopeFilters`, `appointmentScopeFilters` and `threadScopeFilters` return
  `SQL[]` derived from `can()`, agency filter first, zero-UUID fallback (fail-closed).
  `ranges.ts` (agency-clock windows, like-for-like `previousWindow`, `bucketFor`) and the
  `trendSql` / `topSql` / `weekdaySql` / `medianSql` / `bandsSql` pieces in `detail.ts` are
  already compiler primitives. `WidgetData` / `WidgetDetail` are typed apart from drawing.
- **Datasets exist only as SQL inside each widget** — every `*Detail` function's
  `with base as (…)` is a dataset that was never named.
- **Business definitions already disagree:**
  - *Whose received email is it:* `agents.ts` uses the lead's agent, else the contact's;
    `repliesDetail` uses the lead's agent only, else "Agency address". The same mail lands
    on different people on two tiles.
  - *Lead agent of a listing:* `listing_agent`'s key is `(listing_id, user_id)` and
    `display_order` is not unique, so two people can both be 0. `sold_count` joins on
    `display_order = 0` (a sale can count under both, and its `sum() over()` total double
    counts); `detail.ts` picks one with `limit 1`. Headline and report can disagree.
  - *"Active" = live + under offer* is written out in three places.
- **Missing scope helpers:** listings have none — the agency filter and the "only mine" rule
  are copied into five places, and the "only mine" switch is `report:read_agency`, a report
  permission used as a row filter. Contacts have only a subquery (`visibleContactIdsSql`),
  not a `SQL[]` helper; `agents.ts`'s `contacts_held` uses the bare agency filter.
- **Hidden join contract:** `threadScopeFilters` names the `lead` table, so any query using
  it must left-join `lead` under that exact name (a missing join is a Postgres error, not a
  leak — but it must be declared, not remembered).
- **No safety net:** ADR 0027 promised a 3 s statement timeout; it is not in the code.
  `listing` has no index on `agency_id`; `mail_message` has no `(agency_id, created_at)`
  index. Fixed widgets get by; arbitrary group-bys and filters will not.

## Decision

### 1. The architecture: datasets in code, a spec from the model, a compiler on the server

**Datasets, measures and dimensions are code**, in `packages/core/src/semantic/`, reviewed
like any other code. The model can only *combine* them.

- **Dataset:** a root table, its fixed joins, its scope helper, its time fields, and whether
  it is an **event** dataset (rows happen in a range: leads, sales, emails) or a **snapshot**
  (state now: active listings, contacts held).
- **Measure:** a named aggregate written in code (`count`, `sold_value`, `median_price`…),
  with its format (`money` | `count` | `days` | `decimal`) and its permission.
- **Dimension:** a named group-by/filter expression written in code (`agent`, `suburb`,
  `day`…), with its allowed values (an enum list, or "free text, bound as a parameter") and
  its permission.

**A tile spec** is what the model produces, parsed by a strict zod schema
(`tileSpecSchema`, `.strict()` at every level):

```json
{
  "dataset": "sales",
  "measures": ["count", "sold_value"],
  "groupBy": ["agent"],
  "filters": [{ "dimension": "suburb", "op": "in", "values": ["Carlton", "Fitzroy"] }],
  "range": "last_month",
  "viz": "bar",
  "limit": 20
}
```

- `dataset`: one id. `measures`: 1–4 ids of that dataset. `groupBy`: 0–2 dimension ids of
  that dataset (a time bucket counts as one). `filters`: ≤ 5, each on a declared dimension,
  `op` ∈ `eq | in | not_in`, values checked against the dimension's value list or bound as
  text. `range`: one of `WIDGET_RANGES` (ignored by snapshot datasets). `viz`:
  `number | bar | line | table | donut | columns`. `limit`: ≤ 50, default 20.

**The compiler** (`compileTile(spec, ctx)`) turns a parsed spec into **one** SQL statement:

1. Re-parse the spec (stored specs are re-parsed on every read, as ADR 0027 does).
2. Resolve every id through a whitelist map → the code-written SQL fragment. Unknown id →
   the tile is `unavailable`.
3. Ask `can()` **as the viewer** for the dataset, every measure and every dimension. Any
   refusal → the whole tile is `no_access` (never a tile with a figure silently missing).
4. AND the dataset's scope predicates onto the WHERE clause, first.
5. Bind every spec value as a parameter.
6. Run it in a read-only transaction with `SET LOCAL statement_timeout`.

**Storage:** a spec tile is `{ widget: 'custom', params: <spec> }` in the existing
`dashboard.widgets` jsonb. **No migration.** `renderWidget`'s `unavailable` / `no_access` /
`error` tiles keep working, and saved dashboards that use today's widget ids are untouched.

**The assistant** sees the catalog (datasets, measures, dimensions, in plain words) in its
static system prompt (no dates in it, #5), produces a spec, and calls the existing
`show_widget` / `create_dashboard` tools with `{ widget: 'custom', params }`. The tool result
is still only "shown" — the model never sees a figure (#4). A request the catalog cannot
answer gets a plain "that data isn't in the system" and is recorded in a gap log (open
question 2), never approximated.

### 2. The compiler is the security lock

Because the server bypasses RLS (Context), the compiler is the **only** thing between a spec
and every agency's rows. A spec is untrusted input exactly like a URL query string: written
by a model, stored in jsonb, possibly edited later. Nothing in a spec is ever trusted to
express scope — **a spec has no field that can name an agency, a user, a role or a scope**,
and the compiler adds the scope unconditionally.

### 3. No cross-dataset joins

**A spec names exactly one dataset.** It cannot join two datasets, and it cannot reach a
table except through a dimension the dataset declares (always many-to-one: lead → its agent,
listing → its property's suburb). Joins between datasets multiply the scope rules (a lead the
viewer may see, on a listing they may not) in ways a reviewer cannot check by reading one
dataset definition.

A tile that needs several datasets side by side (a per-agent table of leads, emails and
appointments) is **not in v1**. If it is built later, it runs one scoped statement per
dataset, grouped by the same dimension key, and merges the rows in TypeScript — never a SQL
join — under its own amendment to this ADR.

### 4. The v1 datasets

| Dataset | Root (fixed joins) | Kind | Time field | Scope | Always |
|---|---|---|---|---|---|
| `sales` | `listing` (+ `property`, lead agent) | event | `sold_date` | `listingScopeFilters` | `status = 'sold'` |
| `listings` | `listing` (+ `property`, lead agent) | snapshot (+ `published_at` for trends) | — | `listingScopeFilters` | — |
| `leads` | `lead` (+ `property`, assignee) | event | `created_at` | `leadScopeFilters` | `kind <> 'offer'` |
| `appointments` | `appointment` (+ assignee) | event | `starts_at` (may be future) | `appointmentScopeFilters` | — |
| `emails` | `mail_message` + `mail_thread`, left `lead` (as `lead`), left `contact` | event | `created_at` | `threadScopeFilters` | queued sends excluded |
| `contacts` | `contact` (+ assignee) | event / snapshot | `created_at` | `contactScopeFilters` | not merged, not archived |

**Never a dataset:** `property` (shared across agencies, no `agency_id` — reached only through
`listing`, #1) and `user` (global — reached only as the `agent` dimension of a scoped row).

**The `agent` dimension** has one definition per dataset, written once:
`sales` / `listings` → the lead agent (Prerequisite P4); `leads` → `assigned_to`;
`appointments` → `assigned_agent_id`; `emails` → the email owner (P3); `contacts` →
`assigned_to`. Grouping by `agent` is a per-person performance view and needs
`report:read_agency` (as ADR 0034).

**Measures with a rule built in:** `sales.sold_value` always returns its companion
"sold without a disclosed price" count, and a null price is never 0 (ADR 0027 decision 2) —
the rule lives in the measure, not in each spec. `listings.active` is live + under offer
(P5), with the split.

### 5. Compiler invariants (each has a test, and each test is broken once to see it go red)

| # | Rule | How it is checked |
|---|---|---|
| I1 | **Scope always.** Every compiled statement contains its dataset's scope predicates, ANDed first. | **Probe-actor test:** compile every dataset × measure × dimension combination (the catalog is small enough to enumerate) for an agent probe and an admin probe; assert the scope SQL is present and the agency id is a bound parameter. Break: drop the scope in the compiler → red. |
| I2 | **Whitelist only.** Every id in a spec is a key lookup into a `const` map; the SQL it returns is written in code. Spec values are only ever bound parameters. `sql.raw` never receives anything derived from a spec. | Unit: a filter value of `x'); drop table lead; --` compiles to a parameter and returns zero rows without error. A grep test fails if `sql.raw(` appears in `semantic/` with a non-constant argument. Break: pass a filter value through `sql.raw` → red. |
| I3 | **Permission per measure and dimension, as the viewer, on every render.** One refusal → the whole tile is `no_access`. | Permission tests for every measure/dimension with a non-default permission. Break: skip the per-dimension check → an agent sees `sales` by `agent` → red. |
| I4 | **The viewer, not the creator** (ADR 0027 §6). | Smoke: an agent opening an agency-audience custom tile gets their own scope or `no_access`. |
| I5 | **Bounded time.** Every compiled statement runs in a read-only transaction with `SET LOCAL statement_timeout = '3s'`; a timeout is the "Taking too long — try a shorter range" tile. | Unit: `SHOW statement_timeout` inside the compiler's transaction returns `3s`. Break: remove the `SET LOCAL` → red. |
| I6 | **One statement per tile.** The page stays 1 + 1 per tile (+1 for its full report). | `query-count.test.ts`. |
| I7 | **Bounded output.** `limit` ≤ 50; ≤ 2 group-bys; ≤ 4 measures. | zod schema tests. |
| I8 | **No figure to the model.** `show_widget` / `create_dashboard` results say only "shown"; the card preview line is a count. | Existing assistant test extended to `custom` tiles. |
| I9 | **Isolation under generated specs.** | Smoke (rolled back): N generated specs over two agencies — agency A's results never include B's rows; for every spec, an agent's figures are ≤ the admin's. Break: drop the agency filter in one dataset → red. |
| I10 | **Indexes present.** The compiler does not ship until the indexes in P7 exist. | Smoke's index check lists them. |

### 6. Prerequisites — fixed and merged before any compiler code

Each lands on its own with every existing widget green and its figures unchanged, except
where stated.

- **P1 — `listingScopeFilters(actor): SQL[]`** in `packages/core/src/listings/`: the agency
  filter, plus "named on the listing via `listing_agent`" for anyone without the new action
  **`listing:read_all`** (owner/admin). It replaces the five inline copies (`registry.ts`
  `soldInWindow` and `listings_by_status`, `detail.ts` `salesDetail` and `listingsDetail`,
  `agents.ts` `listings_held`). `report:read_agency` stops being used as a row filter.
  Permission test for `listing:read_all`. Sales stay agency-wide for owners/admins, so their
  figures do not change.
- **P2 — `contactScopeFilters(actor): SQL[]`** in `packages/core/src/contacts/`: the same
  rule as `visibleContactIdsSql`, as predicates. `agents.ts` `contacts_held` uses it.
- **P3 — one email owner (`emailOwnerSql`)** in `packages/core/src/mail/`: an outbound
  message belongs to `sent_by`; an inbound one to the lead's `assigned_to`, else the
  contact's `assigned_to`, else "No agent" (ADR 0034 §3). `agents.ts` and `repliesDetail`
  both use it. **This changes a figure people see today:** "Replies by agent" on the Email
  replies report moves mail from "Agency address" to the contact's agent where there is
  one. Treated as a bug fix (decided): TEST-PLAN AH gets an explicit line for it.
- **P4 — one lead agent.** Additive migration, in this order inside one transaction:
  (1) **repair** — for every listing with more than one `display_order = 0` row, renumber
  that listing's rows by (`display_order`, `created_at`, `user_id`) to 0, 1, 2…, so the
  oldest assignment keeps 0 and the others move up (rows already at 1, 2… keep their
  relative order behind them); (2) a partial unique index `listing_agent_lead_idx` on
  `listing_agent (listing_id) WHERE display_order = 0`. Every writer already numbers by
  position (`attachListingAgents`: index 0, 1, 2…), so no write path breaks. **The lead
  agent is the row with the LOWEST `display_order`** (ties impossible at 0, else
  `created_at`, `user_id`), not "the row at 0": offboarding deletes a leaving lead agent's
  row and can leave a co-agent at 1 with nobody at 0. `sold_count` and `detail.ts`'s
  `LEAD_AGENT` become this one expression (`leadAgentSql`), and the headline total equals
  the sum of its rows (smoke check, break-tested).
- **P5 — `ACTIVE_LISTING_STATUSES = ['live', 'under_offer']`**, one constant, used by the
  three places that write it out today.
- **P6 — `withReadTimeout(db, fn)`**: a read-only transaction with
  `SET LOCAL statement_timeout = '3s'`. The existing widgets adopt it too (ADR 0027 promised
  it). `SET LOCAL` is used, never `SET`, so the transaction-mode pooler never carries it to
  another request.
- **P7 — indexes** (additive migration): `listing (agency_id, status, sold_date)` and
  `mail_message (agency_id, created_at)`.

### 7. Migration strategy

- **Phase 0 — prerequisites P1–P7** (above). No compiler code. Migrations: P4 and P7.
- **Phase 1 — compiler and four datasets** (`sales`, `leads`, `appointments`, `emails`), the
  `custom` widget kind, invariants I1–I10. The easy widgets become **presets** — a named spec
  in code — keeping their ids so saved dashboards do not change:
  `new_leads`, `upcoming_appointments`, `email_replies`, `sold_count`. **Parity check before
  each switch:** a smoke test asserts the preset's figure equals the old widget's on the same
  data, for every range; the old query is deleted only after it passes. No assistant changes
  yet.
- **Phase 2 — `sold_value`** (the undisclosed-price companion measure) and the `listings`
  snapshot dataset → `listings_by_status` (live + under offer with the split, scope from P1).
- **Phase 3 — the assistant.** The catalog in the system prompt (new `assistant@vN`),
  `show_widget` / `create_dashboard` accept `custom`, clarifying questions for ambiguous
  requests, the gap log. Evals in `packages/ai` evals (phrases → expected spec) run with a
  fake client in `pnpm test`; live runs only through `pnpm smoke:ai`.
- **Phase 4 — the standard report.** One full-page report (comparison, figures, zero-filled
  trend, breakdowns) generated from a dataset's definition, replacing the per-widget
  `*Detail` functions one by one, each behind the same parity check.
- **`agent_activity` stays a hand-written widget.** It reads six datasets in one statement,
  builds its rows from membership (zeros kept, people who left, a "No agent" row so the rows
  add up), mixes range figures with "now" figures, derives "awaiting reply", and lists each
  person's emails with text. It moves onto the shared definitions (P1–P3, P5) but is not
  expressed as a spec. It is reconsidered after Phase 4, together with the multi-dataset
  tile in §3.

## Consequences

**Better:**
- A new dashboard is a spec, not a code change; only a new dataset, measure or dimension is.
- Each business term (email owner, lead agent, "active", undisclosed price) has exactly one
  definition, so two tiles cannot disagree.
- Tenant isolation is enforced and tested at one choke point instead of in every widget.
- The prerequisites fix today's widgets too (lead-agent double count, missing timeout,
  missing indexes), whether or not the compiler ships.
- Saved dashboards and today's widget ids keep working throughout.

**Costs and risks:**
- The compiler is the highest-stakes code in the console: a bug in it is a cross-agency
  leak. It gets the probe-actor, generated-spec and break tests above, and review on every
  change.
- Flexibility is bounded by the catalog; people will ask for data that is not there. The gap
  log turns that into a backlog, not a failure.
- More query shapes means more performance risk; the timeout and indexes contain it, and
  slow specs show a tile message rather than a broken page.
- P3 changes a figure people already see ("Replies by agent").
- `agent_activity` keeps its own SQL until it is reconsidered.
- The catalog makes the system prompt longer (static, so it is cached).

**Not doing:** model-written SQL or chart code; cross-dataset joins in a spec; per-agency
custom datasets; public share links (still ADR 0027 decision 5).

## Open questions (recommended answer first) — as proposed

1. **May agents save dashboards now?** — *Not until Phase 3 ships* and I1–I9 have run on
   real use; then revisit ADR 0027 Q4 (the viewer's scope makes it safe in principle).
2. **Where does the gap log live?** — *A small table* (agency, user, the request text, the
   nearest dataset if any, created_at; RLS on, no grants), read by the platform team, never
   shown to the model — rather than inside `ai_run` metadata, so it can be counted and
   grouped.
3. **If dev has listings with two lead agents** — *keep the one added first at 0 and move
   the others to 1, 2…*, run only with the user's permission.
4. **Timeout** — *3 s, as ADR 0027*; a tile that needs longer is a sign the range is too wide.
5. **The `agent` dimension for agents viewing their own data** — *keep `report:read_agency`*;
   an agent's own figures are already their whole scope, so grouping by agent adds nothing
   for them.

## Decided (2026-10-12, the user)

- **Architecture and decisions §1–§7: approved.**
- **P3 (email owner): approved as a bug fix** for accuracy and consistency — one correct
  number over two conflicting ones. "Replies by agent" moving mail from "Agency address" to
  the contact's agent stays an explicit TEST-PLAN line.
- **P4 / Q3 (duplicate lead agents): approved — repair before the index.** The oldest
  assignment (`created_at`) keeps `display_order = 0`; the others are renumbered 1, 2, 3…;
  then the partial unique index. Same migration, repair first.
- **Q2 (gap log): a dedicated table, `dashboard_gap_log`**, not `ai_run` metadata, so it can
  be grouped by requested dataset / measure. Built in Phase 3 with the assistant changes.
- Q1, Q4, Q5: as recommended (admins-only saving until Phase 3 has run; 3 s; `agent` needs
  `report:read_agency`).

## As built — Phase 0 (2026-10-12, not committed; migration 0042 written, NOT applied)

- **P1** `listingScopeFilters(actor)` and the new action `listing:read_all` (owner/admin, permission
  test), `packages/core/src/listings/scope.ts`. Used by `sold_value` / `sold_count`,
  `listings_by_status`, `salesDetail`, `listingsDetail` and `agents.ts` `listings_held`; their SQL
  reads the `listing` table unaliased. `report:read_agency` is no longer a row filter.
- **P2** `contactScopeFilters(actor)` in `contacts/visibility.ts` (agency, not merged, and the
  directory's narrowing without `contact:read_all`). `agents.ts` `contacts_held` uses it.
- **P3** `conversationOwnerSql` / `emailOwnerSql` in `mail/owner.ts`. `agents.ts` and
  `repliesDetail` both use them; "Replies by agent" now matches the Agents widget person by
  person, and its unowned row is "No agent" (was "Unassigned"). TEST-PLAN AH11.
- **P4** Migration **0042**: the repair (renumber listings with several rows at 0 by
  `display_order, created_at, user_id`; a row moved off 0 becomes role `co` — decided by the user
  2026-10-12, rows already at 1, 2… keep their role) then `listing_agent_lead_idx`. Tested on PGlite against
  seven fixture listings (two/three zeros, a tie, nobody at 0, clean ones); without the repair the
  index fails. `leadAgentIdSql` (lowest order) replaces the `= 0` join in `sold_count` and
  `detail.ts`'s `LEAD_AGENT`.
- **P5** `ACTIVE_LISTING_STATUSES` in `listings/scope.ts`, used by the three places.
- **P6** `withReadTimeout(db, fn)` in `widgets/read-timeout.ts`: a transaction (a savepoint inside
  one) whose first statement is `set_config('statement_timeout', '3s', true)` +
  `set_config('transaction_read_only', 'on', true)`, always rolled back — which is what undoes both
  (checked on PGlite: inside 3s/on, a write refused, the caller's transaction unchanged and still
  writable). `renderWidget` runs headline + report inside it: **one more statement per widget**. A
  cancelled statement (`57014`) is the new tile state **`too_slow`** ("Taking too long — try a
  shorter range.", `apps/console/components/dashboards/tile.tsx`).
- **P7** Migration 0042: `listing_agency_status_sold_idx`, `mail_message_agency_created_idx`.
- Tests: unit 922 + 296 (scope helpers, `listing:read_all`, the owner expression, the guard, the
  too-slow tile); break-tests red: narrowing dropped, `listing:read_all` removed, guard statement
  removed, repair removed (PGlite). Smoke written, **not run** (0041 and 0042 not applied): "a
  sale counts once, under its lead agent", "figures read with a 3 s timeout…", the P3 agreement
  inside the Agents check, and the three indexes in the index list.


## As built — Phases 1–4 (2026-10-12, branch `feat/semantic-layer`; migration 0045 applied on dev)

- **Catalog** `packages/core/src/semantic/catalog.ts`: six datasets — `sales`, `listings`
  (snapshot), `leads`, `appointments`, `emails`, `contacts` (event; `all_time` allowed) — with
  their measures, dimensions (value lists where there is one), the `agent` dimension needing
  `report:read_agency`, and each dataset's report config. No `sql.raw` in the folder (a test
  greps it). Free-text filters ignore case; listed values match exactly.
- **Spec** `spec.ts` (`tileSpecSchema`, strict at every level, bounded: ≤ 4 measures, ≤ 2
  group-bys, ≤ 5 filters of ≤ 20 values, ≤ 50 rows; time steps checked against the range; a
  snapshot takes no range). Errors name the valid ids so the model can correct itself.
- **Compiler** `compile.ts`: one statement — `base` (scope first, then the dataset's rule, the
  window, the filters), the groups (zero-filled when the only group is a time step; to today,
  or to the end of the range for appointments), the total over all rows, the companions.
  `mayViewSpec` asks the dataset's, each measure's and each dimension's permission as the viewer.
- **Phase 1–2 presets:** `new_leads`, `upcoming_appointments` (client meetings, ADR 0038),
  `email_replies`, `sold_count`, `sold_value` and `listings_by_status` now run their figure as
  a named spec; their ids, shapes and full-page reports are unchanged. Parity: smoke "presets
  …" compares all six with the old SQL written by hand, every range, owner and agent (the old
  queries are deleted; the hand-written SQL stays as the check).
- **`custom` widget** in the registry (`{ widget: 'custom', params: <spec> }`, no migration);
  `renderWidget` asks `permits(actor, spec)` instead of one fixed permission.
- **Phase 3 — the assistant:** `show_widget` / `create_dashboard` take `{ widget: 'custom',
  spec }`; prompt **`assistant@v13`** carries the catalog (`catalogForPrompt()`, pinned by a
  hash test) and the rules: fixed widget when exact, one dataset per tile, several tiles side
  by side, ask only when it changes the figure, `report_missing_data` instead of an
  approximation. **Gap log** table `dashboard_gap_log` (migration **0045**, RLS on, no
  grants), classified own-agency. Evals: `packages/ai/src/evals/dashboard-phrases.ts`
  (14 phrases: fixed, custom, missing) — offline test checks every expected answer is valid;
  the live comparison is in `pnpm smoke:ai` only.
- **Phase 4 — the standard report** `report.ts`: for a custom tile on the dashboard page, one
  more statement: the first measure against the same point in the period before, the
  dataset's figures, a zero-filled trend, up to four breakdowns (a breakdown the viewer may
  not see is left out). The six fixed widgets keep their own reports (they carry figures the
  standard report does not have yet — per-day averages, weekdays, the 12-week listings trend);
  moving them is a follow-up behind the same parity check.
- **Console:** `components/dashboards/custom.tsx` draws number / bar / line / columns / donut /
  table with the notes and "showing N of M"; the report skips the trend card for a snapshot.
- Not done: agents saving dashboards (Q1, after Phase 3 has run in real use); cross-dataset
  tiles (§3); a screen for reading the gap log.
