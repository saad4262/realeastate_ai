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

