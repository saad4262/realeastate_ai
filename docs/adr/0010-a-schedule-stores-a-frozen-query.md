# 0010 — A schedule stores a frozen query, not a prompt to re-interpret

**Status:** accepted, 2026-09-26. Establishes the AI task scheduler. Depends on
consumer accounts (M4), which this feature is the first caller of.

**Context.** A person saves a prompt — "houses to rent in Pakenham under 30 km"
— and a time, and wants results every day by email and in the app. The obvious
reading of "the AI runs the research daily" is that `runPropertyChat` runs
again each morning. That reading is wrong here, and it is wrong for reasons
that are not obvious, so this is written down.

**Decision.** The prompt is interpreted by the model **once**, when the
schedule is saved, and the resolved `PublicSearchQuery` is stored on the row.
Every scheduled run reads `search_schedule.query` and executes it as SQL. The
model is not in the run path. The prompt is kept verbatim beside the query, for
display and for a deliberate, user-initiated re-interpretation — never an
automatic one.

**Why.** Three reasons, in order of how much they cost to get wrong:

- **A scheduled search must be the search that was confirmed.** A person saw
  results on screen and said "send me this daily". If the model re-reads the
  sentence each morning, the search can drift — a prompt change, a model swap,
  or the non-determinism that `effort: medium` exists to buy could quietly
  change what "under 30 km" resolves to. They would not be told.
- **Cost is unbounded the other way.** Every existing ceiling — the 10/min
  per-IP limiter and `AI_CHAT_DAILY_TURN_CAP` — is an in-process `Map` keyed
  on an IP address. A cron tick has neither. A hundred daily schedules is a
  hundred multi-round metered turns a day against nothing at all.
- **A frozen query is auditable.** The row says what will be searched. Under
  the ACL and NSW underquoting rules, "what did we actually send this person
  and why" has to be answerable from the database, not reconstructed from a
  model's mood.

**Alternatives.** Full re-run each time: rejected above. No model at all, with
a form instead of a prompt: rejected because the conversational entry is the
product. A middle option was taken — **one** cheap Haiku call per run writes
the email's two sentences of prose, handed already-formatted strings and
integer counts, so #4 holds structurally: the model has no tool and no number
to produce, and a summary containing a `$` or a 3+ digit run is rejected in
favour of a template.

**Consequences.** A schedule does not improve as the prompt vocabulary
improves, so the UI must offer "re-run the prompt" as a visible action rather
than doing it silently. A run costs one cheap call, not four expensive ones,
and degrades to a templated summary when the durable budget in
`packages/core/src/schedules/budget.ts` says no — the alert still goes out,
only the prose is plainer. Dropping an alert to save a cent is the wrong trade.
