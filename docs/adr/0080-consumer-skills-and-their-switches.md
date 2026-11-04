# 0080 — Consumer skills: a catalog of 21, a switch each, on the public site

**Status:** accepted, 2026-11-03 (the user's three answers, each the recommended option). Migration 0081.
Plan and order: `docs/CONSUMER-SKILLS.md`.

**Context.** The client lists 21 AI skills for buyers on the public site. About 16% exists, almost all of
it as tools inside the property chat, and none of it can be turned off. The agency side has switches
(ADR 0058, 0069), but `skill_switch.agency_id` is NOT NULL and a consumer has no agency (ADR 0011) —
giving them one is the privilege escalation that ADR rejects.

**Decision.**
1. **A fixed catalog in code**, `packages/core/src/consumer-skills/catalog.ts`: 21 skills in six groups,
   each with a key, a name, a line on what it does, a kind (`answers` or `acts`), whether it needs an
   account, and a status (`live`, `partial`, `planned`). Pure data; the page, the chat and the tests read
   the same list. A new skill is an entry plus its gate, both reviewed.
2. **Defaults by kind (the user's answer 1).** `answers` is ON, `acts` is OFF until the buyer switches it
   on. Smart Alerts is `answers`: each alert is already the buyer's own request, and existing alerts keep
   running. A visitor who is not signed in gets the defaults and has no switches.
3. **Stored as exceptions from the default**, in its own table: `consumer_skill_switch(user_id, skill_key,
   enabled)`, primary key (user_id, skill_key). No row = the catalog's default. Classified
   `PUBLIC_SITE_USER`. `can()` gains `consumer_skill:read` / `consumer_skill:manage`: only the owner, and
   — as schedules and chats — no agency role crosses that line.
4. **The platform can pause a skill for everyone** with `CONSUMER_SKILLS_PAUSED` (comma list of keys). A
   paused skill is off whatever the buyer chose; the page says so. An admin-console switch can come later.
5. **Off means off where it runs.** The chat's tools map to skills; a tool whose skill is off returns an
   error result telling the guide to say it is switched off in Skills. The tool list stays the one frozen
   list, so the prompt cache is unchanged. A `planned` skill has no switch until it is built.
6. **Data (the user's answer 2):** our records and free public data first; a skill with too little data
   says so. **Order (answer 3):** after this foundation, Affordability, Due-Diligence, Renovation.

**Alternatives.** Reusing `skill_switch` with a nullable agency (rejected: every agency-scoped read of it
would have to learn a new case, and the unique index's `coalesce` trick already uses `user_id`). A switch
per chat tool rather than per skill (rejected: the buyer thinks in skills, not tools).

**Consequences.** Changing a skill's default later changes it for everyone who never touched that switch —
deliberate, and an ADR each time. Every new consumer skill gets a catalog entry, its gate and a test that
the gate refuses when it is off.

**Amendment, 2026-11-03 — C2 Due-Diligence, decision 4 (the user: "aage kam shuru kro", the mock's seven
decisions as recommended).** Prices were never kept, only the current one. Migration 0082 adds
`listing_price_change` (classified OWN_AGENCY) written by a trigger on `listing` for every path that edits
`price_display` / `price_from` / `price_to`, and only once the listing has been public. Applied 2026-11-03,
so "since we began recording on 3 Nov 2026". The public records keep ADR 0013's history: withdrawn campaigns
stay out (the mock's withdrawn example is not shown).

**Amendment, 2026-11-03 — C3 Renovation, approved by the product team** (mock `consumer-renovation.html`). No
renovation cost figure from the platform: there is no free, official price source, so the skill gives what a cost
depends on, the trades, the permit notes, and compares the buyer's own quotes — arithmetic in core, in whole cents.
The model picks only from the 25 kinds of work in `packages/core/src/renovation/categories.ts`; its photo answer is a
strict schema of room types, so a word about condition refuses the answer. Permit notes exist only with an official
state source and date; a state without one says "not verified".

**Amendment, 2026-11-03 — C4 Profile and watch, all seven decisions approved** (mock `consumer-profile-watch.html`).
The shortlist is a basic feature with no switch. Property Monitor watches an address, not an ad, and says only
"no longer advertised" for a withdrawn campaign (ADR 0013); it emails once a day and is off until switched on.
Personal Property AI learns only from the buyer's own actions, as editable facts with their sources, never
anything about the person, and is opt-in with "Forget everything". No agency sees any of it (ADR 0011).
Built: migration 0083 (`property_watch`, `property_watch_event`, PUBLIC_SITE_USER) — a watch remembers what it last
reported, and a check reports the difference; the daily email carries a third unsubscribe token kind (`w.`) that
switches Property Monitor off.
Personal Property AI built: migration 0084 (`buyer_profile`, PUBLIC_SITE_USER) stores only "Forget everything"'s time
and the buyer's edits; the profile is counted on read from actions made after the switch was turned on (its row's
time) or the last forget. The guide gets one line as an uncached system block after the cached prompt.

**Amendment, 2026-11-03 — C5 Research** (mock `consumer-research.html`; the user: "begin executing the ABS migration
and Phase C5", taken as the seven decisions recommended). Never a value, a prediction or a verdict: the model's lines
also pass a verdict filter in core. A suburb median only with 10 sales on this site in 12 months, computed by
Postgres and labelled as this site's. ABS Census 2021 housing figures only (no income, age, ancestry or religion),
in migration 0085 `suburb_census` (SHARED reference data), loaded idempotently by `pnpm --filter @repo/db db:census`
from `packages/db/data/census/` (built from the ABS DataPack by the script beside it). Comparables are listed,
never averaged.


**Amendment, 2026-11-04 — C6 Inspections** (mock `consumer-inspections.html`; the user approved all nine decisions as
recommended). Inspection AI plans a day only from the agents' OPEN times (`inspection`), picking one per home and
checking each stop against the buyer's own gap and time inside; distances are PostGIS straight lines, labelled so —
never a driving time. A home that does not fit stays on the plan with its other times. The plan lives in its link
(`/inspections?l=…&s=…`, the homes travel with the times so a removed time still names its home), one `.ics` and a
Google Maps link; the guide gets `plan_inspections` (prompt v15) and never reads notes. Inspection Assistant
(migration 0086: `inspection_note`, `inspection_photo`, PUBLIC_SITE_USER) is owner-only by `can()`
(`inspection_note:read/manage`): no agency role, no platform admin, and nothing else reads the tables. Photos: the
browser redraws them at 2,048 px (dropping metadata), the server identifies them by their bytes and strips Exif/XMP/
IPTC/comments again, and stores them in the PRIVATE `inspection-photos` bucket behind five-minute signed links; up to
20 a home, 4 MB after resizing (a serverless request carries 4.5 MB — the "10 MB" of the mock is the camera file the
browser accepts before resizing). The summary sees only the buyer's marks and notes — never a photo — and core keeps
a line only when it cites them, every figure is theirs, it passes the verdict rule, and any condition word
(asbestos, termites, "structurally sound"…) is one they wrote. It reaches only the buyer, labelled, and is not stored.
Deleting a notebook deletes its rows first, then its files; deleting is allowed with the skill off.

**Amendment, 2026-11-04 — C7 Discovery and Opportunity** (mock `consumer-discovery.html`; the user approved all ten
decisions as recommended, singling out the 12-month rule and the strict median). Discovery AI suggests only from what
the buyer chose to give: a public listing's own suburb, kind, bedrooms and price (Similar homes — nothing about the
visitor, one cached list for everyone), or their Personal Property AI profile while it is on (For you). Postgres
applies the hard filters and `rankSuggestions` the rest: one difference at most, named (a suburb within 5 km straight
line, one more bedroom, no price), never over budget or another kind; no model picks, ranks or writes a reason. Homes
not for sale appear only where this site SOLD them 12+ months ago and nothing is listed or being prepared there, at
most three, apart, watch first. "Not for me" hides an ADDRESS (migration 0087: `discovery_hidden`, PUBLIC_SITE_USER,
`discovery_hidden:read/manage` owner-only), teaches nothing, and "Forget everything" clears it in the same transaction.
Opportunity AI: public homes FOR SALE with a price reduction (the newest recorded change lowered the low end), a
campaign of 60+ days, or an asking low end below this site's median for the same suburb, kind AND bedrooms with 10+
sales in 12 months — each with our fixed text on what it can mean and two questions for the agent; a test bans
judgement words from that text and confines them in prompt v16 to sentences that forbid them. Each empty signal says
why. The guide gets `discover_homes` and `find_opportunities` (records only; the session, never the model, decides
whose profile).

**Amendment, 2026-11-04 — C8 Acting for the buyer** (mock `consumer-acting.html`; the user approved all twelve decisions,
singling out no AI label on the agency's copy, five a day, and automations that never contact an agent). Acting stops at
the buyer's own account. Agent AI drafts from the buyer's own words in the conversation (the request's, never the
model's) and the listing's public facts; core rejects an offer, a claim to act for them, a figure in neither source,
money matters they did not raise, or contact details, and uses a template instead. The buyer edits and presses Send;
it goes as a reply in their conversation about that home, else an ordinary enquiry (`createEnquiry`), name and email
from the account, five a day (`guide_message`), no mark on the agency's copy, "Drafted with the guide" on theirs. Tasks
are `search_schedule` rows with `kind = 'task'` (migration 0088: `kind`, `sections`, `skip_empty`, cadence `once`,
status `done`, `schedule_run.report`) on the alerts' claim — which now filters by kind and claims a task only while
Tasks is on — with a report of up to four fixed sections from SQL and an opening sentence handed no figures (core
rejects digits, counting words and verdicts; labelled). Automation (`buyer_automation`, `automation_event`): a fixed
"when" over the buyer's shortlist and watched addresses, detected in SQL on the alerts cron, each event once; "then" is
only tell me, add to or take off their own shortlist, in the same transaction as the event, with Undo. Emails at 8 am
or hourly outside 9 pm–7 am, with `a.` (one automation) and `m.` (the skill) unsubscribe tokens. The guide proposes
with `draft_message`, `draft_task`, `draft_automation` — signed cards (`acting/signed.ts`), nothing until the button
(prompt v17).

**Amendment, 2026-11-04 — C9 Media and land** (mock `consumer-media-land.html`; the user approved all twelve decisions
and the providers: Voyage `voyage-multimodal-3.5` into pgvector, no video pipeline, each state's own zone layer where
the licence allows a commercial site). Built in order. *Immersive:* floorplans are listing images (`media.kind =
floorplan`); a video or tour is a link on a fixed allowlist (YouTube, Vimeo, Matterport) stored as `provider:id` — never
a URL, which keeps `storage_key`'s rule — and embedded by code from that, loading only on play. The floorplan's rooms
are read by a vision model into C3's room types under a strict schema (names only: a size, an area or a count refuses
the answer), on the alerts cron, metered; the guide's `floorplan_rooms` (prompt v18) never gives a size. No migration. *Development:* the zone by the property's map point (the geocoder's, or the agent's own pin; a point with
no source is no lookup) from the state's own layer — VIC (Vicmap WFS) and NSW (Planning Portal, layer 19) asked live
before any transaction and kept 30 days per point by the web, never kept when the service failed; SA's Planning and
Design Code zones (CC BY 3.0 AU, a download only) loaded into `planning_zone` (migration 0089, the user's go; GiST
probe; simplified to about a metre, 20 MB), "data dated" by the file. WA (non-commercial licence), QLD (no statewide
layer), TAS, ACT and NT say "not verified" and link a checked map where there is one. What the state sends is read
against the shapes it publishes; anything else shows nothing. The panel: the zone, the land size the page beside it
shows (ADR 0075), the overlay map, "not a permission", five fixed questions; no model writes it. The guide's
`land_and_zoning` (prompt v19) copies it and gives no advice.
