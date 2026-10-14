# 0042 — Open questions on an agency's data: the assistant writes the query, the database holds the lock

**Status:** ACCEPTED, 2026-10-14 (the user; the four "Open" defaults confirmed). Amends ADR 0036: its line "letting the model write SQL is
**ruled out**" is replaced by this ADR for **reading**. The catalog (0036) stays as the first
path. Writes are unchanged: they still go through cards (ADR 0040, 0041). Asked by the user
(Roman Urdu, paraphrased): "Don't keep the AI on a fixed list. Tomorrow an agency owner will
ask something new, and we can't train the model for each request. It should answer any
question about the agency's data, and build any dashboard, the way you build what I ask.
If the agency doesn't hold the data, or the question isn't about its data, it should say so.
It may take its time."

## Context

ADR 0036 answers a request only when it fits the catalog: 6 datasets, about 40 measures and
dimensions, and 5 filters. That is safe, but it is closed:

- "average leads per day" fails, because a count per day exists but an average over days does not
- "which agent replies fastest in Pakenham" fails, because reply time is not a measure
- "leads from buyers who also own a property with us" fails, because 0036 has no joins across datasets

Each one is a code change. The gap log tells us what people asked for, but the owner waits.

0036 ruled out SQL written by the model for three reasons. This ADR answers each one with a
different design:

| 0036's reason | Why it held | What changes here |
|---|---|---|
| One missing `agency_id` filter shows agency A's data to B | The server connects as the table owner and bypasses RLS. The WHERE clause was the **only** lock | The query runs as a **separate database role**, under **RLS keyed to an unguessable ticket**. The database refuses other agencies' rows, whatever the SQL says |
| A wrong join gives a figure that looks right | Rule 4: a figure must be trustworthy | The figure still comes from SQL, never from the model. Every open tile is labelled, shows how it was worked out, and shows the query to owners and admins |
| Viewer scope cannot be guaranteed in generated SQL | Agents see only their own records | The model never sees base tables. It queries named datasets that core builds from the same scope helpers the dashboards use (`leadScopeFilters` …) |

No training is needed. The model is told, in every analysis turn, what data exists
(the data dictionary, Part C). It reasons about a new question the way it reasons about
anything else.

## Decision

### Part A — Two paths, catalog first

1. If the request fits the catalog (0036), use it. It is fast, tested and cached.
2. If it does not, the assistant takes the **open path**. It reads the dictionary, runs
   exploratory queries, looks at the results, and then answers or proposes a dashboard.
3. If the question needs data the agency does not hold, or is not about the agency's data,
   the assistant says so in plain words ("Your account doesn't hold commission amounts"),
   and the request goes to the gap log (0036). It never guesses.

### Part B — The sandbox: five locks, any one of which is enough to stop a leak

**L1 — The parser.** Every query is parsed by the real Postgres parser (`libpg-query`, WASM;
verify with Context7 before building). A query is accepted only if all of these hold:

- it is exactly one `SELECT` statement (CTEs allowed); nothing that cannot be parsed is run
- every table name is one of the **named datasets** (Part C), with no schema qualifier
- every function is on an **allowlist**: aggregates, date/time, math, string, `coalesce`,
  `case`, window functions. Never `set_config`, `current_setting`, `pg_*`, `dblink`, `lo_*`,
  `nextval`, `pg_sleep`, or anything with a side effect
- there is no `FOR UPDATE` or `SHARE`, no `INTO`, no `COPY`, no `pg_catalog` or
  `information_schema`, and no comments
- it is at most 4,000 characters

**L2 — Scope, from core.** The named datasets are CTEs that core puts in front of the model's
query. They are built from the existing helpers (`leadScopeFilters`, `listingScopeFilters`,
`contactScopeFilters`, `appointmentScopeFilters`, `threadScopeFilters`). An agent's `leads`
dataset is therefore their leads only, by the same rule as every other screen. Parameters
are bound, never spliced.

**L3 — The role.** The query runs inside `SET LOCAL ROLE ai_reader`. That role has no login.
It has column-level `SELECT` only on the columns the datasets expose. It has no tokens,
password hashes, OAuth secrets or webhook keys. It has no other schema, and no write grant of
any kind.

**L4 — RLS keyed to a ticket.** Before each query, core commits a row to
`ai_query_ticket`: a random UUID, agency, user and an expiry 60 seconds away. The query's
transaction sets `ai.ticket` to that UUID. Every exposed table gets a policy
`FOR SELECT TO ai_reader USING (agency_id = ai_ticket_agency())`. `ai_ticket_agency()` is a
`SECURITY DEFINER` function that reads the ticket. `ai_reader` cannot read the ticket table.
To reach another agency's rows, a query would need another agency's live ticket UUID, so
**agency isolation holds even if L1 and L2 both fail.** (Tables without `agency_id`, such
as `property`, get a policy through their listing.)

**L5 — The transaction.** It is `READ ONLY`, with `statement_timeout` 5 s and
`lock_timeout` 1 s. At most 500 rows are kept for display, and 50 go to the model. There is
a per-agency cap of 60 open queries an hour, because the dev and production databases are the
same database. A read replica is a later step, not part of this ADR.

### Part C — The data dictionary: what exists, and what does not

The model is given one text, the same for every agency and built from code (cacheable,
rule 5). It describes:

- **The named datasets**, about 12 of them: `leads`, `contacts`, `listings`, `properties`,
  `sales`, `appointments`, `emails` (messages with direction, time, thread, agent, contact),
  `threads`, `agents` (name, email, phone, role, **territory suburbs**), `offers`, `notes`,
  `templates_sent`. Each column has a meaning and its units: money in AUD, times in UTC, and
  the agency's time zone given.
- **Join keys between them**, for example `leads.contact_id = contacts.id`.
- **What we do not hold**, listed by name: commission amounts, marketing spend, website
  visits by source, expenses, payroll, vendor-paid advertising, portal (REA/Domain) leads that
  were not imported, and anything about other agencies. The rule given to the model: if a
  question needs something that is not in the dictionary, say it is not held. Never stand in
  a near-match without saying so.

Adding a dataset or a column is a code change and a dictionary line. The gap log says which
ones are worth adding.

### Part D — How the assistant works through a question

New read tools:

- `describe_data`: the dictionary, or one dataset in detail
- `run_query`: runs a query through L1 to L5. It returns rows, or the parser's or
  database's error in plain words, so the model can correct itself
- `propose_open_tile`: a card with the tile's title, chart, the model's one-line
  explanation, and a preview of the real result

An analysis turn gets a larger budget: 20 tool calls instead of 8. The console shows a short
line for each step ("Looking at leads by suburb…") so a slow answer reads as work, not as a
hang. A turn may take about 60 to 90 seconds.

Approve saves the tile on a dashboard (the existing `create_dashboard` and `add_tile` cards,
with a new tile kind `open`). Only the person's own dashboard changes, as today.

### Part E — Other people's words never reach the model

Email bodies, snippets, subjects, notes and contacts' free text are **display-only columns**
(ADR 0034: "drawn as text, never handed to a model"):

- A query may select them, so a dashboard table can show "the reply that came in".
- In the rows `run_query` returns to the model, each such value is replaced by
  `[text shown to the person, not to you]`.
- Filtering on them with `ILIKE` or similar is allowed, because the model writes the pattern
  and never reads the text.

This closes the door to prompt injection from an email body.

### Part F — Trust in an open figure

Every open tile:

- carries the label "Worked out by the assistant"
- shows the model's one-line explanation ("Average of new leads per day, last 30 days,
  Pakenham listings only")
- has **Show query**, for owners and admins

On each refresh the query is checked again by L1, and run again as the **viewer**, with the
viewer's own ticket and scope, never the creator's. If the data model has changed and the
query no longer passes, the tile says "This tile needs rebuilding — ask the assistant" and
shows no stale figure.

### Part G — Nobody is dropped: completeness, and "no information yet"

The most common wrong answer from model-written SQL is not a leak. It is a **silent
omission**: an inner join drops the agent who has no emails, and the table looks complete.
The rules that prevent it:

1. **The dictionary teaches the shape.** A "per agent", "per suburb" or "per listing" question
   starts from that dataset and LEFT JOINs the activity onto it. The rule is in the
   dictionary, with an example.
2. **The tool checks it.** When a result is grouped by agent, `run_query` compares the agents
   it returned with the agency's active members. Anyone missing is named back to the model
   ("3 agents are not in your result: Ali, Sara, Omar — include them") before a card can be
   proposed.
3. **Empty is shown as empty.** A null or missing value is drawn as "No information yet", or
   as "0" when it is a count. It is never left as a blank cell. An agent with no territory
   reads "No territory set".
4. **The card previews the real result**, including the empty rows, before anything is saved.

Worked example. Request: "a dashboard of every agent's email replies and leads, with their
name and location." This becomes one tile, listing agents with:

- name, email and territory suburbs
- emails in and out, and replies awaited, each with a count (30 days)
- new leads
- a table of their latest replies: the time, who it is from (the contact's name, email and
  phone), and the reply text (display-only, Part E)

An agent with nothing reads "No information yet" in every column, and is never missing.

### Data (additive migration)

- role `ai_reader`, with its column grants, and `GRANT ai_reader TO postgres` so the server
  can `SET LOCAL ROLE`
- table `ai_query_ticket` (RLS on, no policy, purged by the alerts cron)
- function `ai_ticket_agency()`, and the policies on each exposed table
- table `ai_query_log` (agency, user, the SQL, milliseconds, rows, outcome), for audit and
  the per-agency cap
- `dashboard_tile` accepts kind `open`, with the stored SQL and explanation

## Safety, restated

- The model writes a query. It never writes a figure. Every figure is a database result (rule 4).
- Four locks stand between agency A and agency B's rows (L1, L2, L3, L4). L4 alone is enough.
- Nothing on this path writes. L1 rejects writes, L3 has no write grant, and L5 is read only.
- Other people's words are shown to the person and never handed to the model.
- Nothing in this ADR sends anything to a third party.

## Tests (each with its break-test)

| # | Invariant | Test | Break → red |
|---|---|---|---|
| I1 | No agency sees another's rows | Smoke: agency A runs `select * from leads` with B's id in the WHERE clause, and gets 0 rows. Then the same with L1 and L2 switched off in a test harness: still 0 | Drop the RLS policy |
| I2 | The ticket cannot be swapped | `select set_config('ai.ticket', …)` is rejected by L1. With L1 off: a made-up UUID gives 0 rows; an expired ticket gives 0 rows | Make `ai_ticket_agency()` ignore the expiry |
| I3 | Nothing writes | Smoke: `insert`, `update`, `delete`, `for update`, `nextval` and a writable CTE are all rejected by L1. With L1 off, the database refuses them (read only, no grant) | Grant `INSERT` to `ai_reader` |
| I4 | Secrets are unreachable | Smoke: selecting a token or a password hash gives "permission denied" | Grant the column |
| I5 | Agents see only their own | Smoke: an agent's `count(*) from leads` equals their count on the Leads screen | Drop the scope CTE predicate |
| I6 | A heavy query stops | Smoke: a big cross join and `pg_sleep` are cancelled within 5 s | Raise the timeout |
| I7 | Display-only text never reaches the model | Unit, with a fake model: the model sees the placeholder; the tile sees the text | Pass the raw rows |
| I8 | Missing data is called missing | Evals (offline, a fake client): "commission by agent" and "marketing spend" lead to a reply that says the data is not held, and no query is run | Remove the "not held" list from the dictionary |
| I9 | No system catalogs | `pg_catalog`, `information_schema` and `pg_roles` are rejected by L1. With L1 off: no grant | Allow the schema in L1 |
| I10 | Nobody is dropped | Unit: a per-agent result missing an active member gets the missing names back, and no card. Smoke: an agent with no data appears as "No information yet" | Skip the member check |

## Phase 0 — check before building (half a day)

- Confirm that the Supabase `postgres` role may `CREATE ROLE` and `SET LOCAL ROLE` through the
  transaction pooler. If it may not, L3 and L4 move to a second connection string for
  `ai_reader`. The design stays the same.
- Confirm that `libpg-query` (WASM) runs in Vercel's Node runtime and on macOS.

## Estimate

About 4 to 5 days:

| Part | Time |
|---|---|
| Phase 0 | 0.5 day |
| Migration, role and RLS (L3, L4) | 1 day |
| Parser and datasets (L1, L2) | 1 day |
| Tools, the dictionary and the prompt | 1 day |
| Open tiles in the console | 0.5 day |
| Smoke I1–I9 and evals | 1 day |

## Decided (2026-10-14, the user — the proposed defaults)

1. **Who gets it:** owners and admins see agency-wide data. **Agents get it too, on their own
   data only** (L2). Read-only members do not get it.
2. **Show query:** owners and admins only.
3. **Caps:** 60 open queries per agency per hour, and 20 tool calls per analysis turn.
4. **Saving answers:** an answer typed in chat is not saved, and a tile is saved only on approve.

## As built — Phase 0 (2026-10-14): both checks pass

- **Role and pooler:** the server connects as `postgres` (not superuser; `CREATEROLE` yes,
  `BYPASSRLS` yes) through the transaction pooler (port 6543), on Postgres 17.11. Inside
  one transaction, `SET TRANSACTION READ ONLY`, then `SET LOCAL ROLE authenticated`, then
  `set_config('ai.ticket', …, true)` all work. A table without a grant gives `42501
  permission denied`. L3 and L4 therefore need **no second connection string**. On
  Postgres 16 and later, a role made with `CREATEROLE` is not settable by its creator by
  default, so the migration adds `GRANT ai_reader TO postgres WITH SET TRUE`.
- **Parser:** `libpg-query@18.1.5` (WASM, 1.8 MB) runs in Node. It returns one node per
  statement (`SelectStmt`, `DeleteStmt` …), so "exactly one SelectStmt" is a plain check, and
  it rejects text it cannot parse.
