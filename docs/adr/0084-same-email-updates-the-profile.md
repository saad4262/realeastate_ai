# 0084 — The same email on Add or an import updates the profile

**Status:** accepted, 2026-11-07 (the user's two answers, both the recommended option). Replaces ADR 0079 §5's "never overwrites" for Add and the import. No migration.

**Context.** ADR 0079 kept a value already on a profile and put the other one on the timeline. The user now wants an agency's new data to update the customer it is about.

**Decision.**
1. On Add customer and a contacts import, a different **name, phone or address** on an email the agency already has replaces the old one. The old value stays on the timeline (`details_replaced`: field, from, to, via). Blanks fill as before.
2. **Only someone who may edit the person replaces** (`contact:update`: owner, admin, or the agent they are assigned to). Anyone else who may add contacts fills blanks and offers the rest (`details_offered`), as in ADR 0079, so one agent cannot change another agent's customer. Coming in at all stays `contact:create` (ADR 0079 §6).
3. **An empty cell erases nothing.** An address replaces only when no part the profile has would be lost; otherwise it is offered, so a file with only a suburb cannot erase a street.
4. Within one file the later row of an email wins. Same-phone matching is unchanged: a suggestion only.
5. Next action, assignee, consent and opt-out are unchanged by this: a next action fills only a blank one, and the assignee and consent keep their own rules.
6. **Enquiries do not replace.** `contact_upsert` still fills only a blank phone (answer 2): the public form does not verify an email, so anyone could otherwise rewrite someone's profile by typing it.
7. The template holds only name, email, phone and address (street, suburb, state, postcode). The other columns still map if a file has them, and a column we have no field for is ignored.
8. **Every import row needs all four** (the user, same day; replaces ADR 0079 §3 for the import): a name, an email, a phone and a street address. A row without them is a problem in the report and is not imported; the rest of the file goes in. The mapping screen asks for those columns first. One Address column is accepted: "3/12 Campbell Parade, Bondi Beach NSW 2026" is split when street, suburb, state and postcode can all be told apart, and otherwise kept as written. A row missing an address is not sent for an AI fix, since the model may not propose one. Automatic capture and Edit still ask for none of them.
9. **The assistant** opens the same import screens (`start_import`, ADR 0029): file upload, or Google Sheet connect and pick. It never sees the file. Prompt `assistant@v31` says these rules.
10. **The assistant's `create_contact` card** (the user, same day) asks for the same four and, approved, runs the same `addOrFillContact` as the form: an email already held updates that profile by §1–§3. The card shows only what the person gave, never what the profile holds. A card proposed before this still runs as it was frozen. `update_contact` is not changed.

**Alternatives.** Keep ADR 0079 (the user's new answer). Replace for anyone who may add (one agent could rewrite another's customer). A separate "update" switch on the import (a step the user did not ask for).

**Cost.** Uploading an old file again undoes newer edits on what it holds. The old values remain on the timeline. The user accepted this when choosing.

**Where it lives.** `planFill` and `fillContact` in `contacts/write-contacts.ts`; wording in `imports/contacts.ts`, `contact-form.tsx`, `import-start.tsx`, `import-detail.tsx`; timeline in `contact-profile.tsx`.
