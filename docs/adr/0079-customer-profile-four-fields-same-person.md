# 0079 — Customer profile: four fields to start, and the same person always lands on one profile

**Status:** accepted, 2026-11-02 (the user's four answers, all the recommended option). Built on
`feat/customer-profile`. Migration 0080 (additive, nullable columns) — rolled-back dry run clean 2026-11-02 (twice in
one transaction; 6 columns; 10 contacts untouched); NOT applied — the user's go.

**Context.** The user wants agencies to add their existing (old) customers, each with a profile that starts with
name, email, phone and address and then collects everything else over time. Most of it exists (ADR 0018 Contact
360, ADR 0056 import). Three gaps: a contact has **no address of their own** (only `contact_property` ties to a
home); the Add form requires only a name; and the same email is **refused** — the import skips the row ("already a
contact — skipped") and Add throws `duplicate` — so an old customer's file never adds to the profile they have.

**Decision.**
1. **Address on the contact** (answer 4): `address_line` (the street part, "3/12 Campbell Parade"), `address_suburb`,
   `address_state`, `address_postcode`, `address_latitude` / `address_longitude` (numeric, as `property`). It is where
   the person lives, not a property: it never makes or touches a `property` row (`contact_property` stays for homes
   they own/sell/rent). The Add and Edit forms use the listing form's address picker; its pin is kept when it gave
   one, and a typed edit drops it. **The server never geocodes a home address** (no network call, no cost). An import
   keeps the text as written; Street address / Suburb / State / Postcode are their own columns (a state name becomes
   NSW…, a spreadsheet's `800` becomes `0800`). The directory searches suburb and street too.
2. **Four fields required on Add customer** — name, email, phone, address (the form's schema only). Automatic capture
   (enquiry, offer, email) and Edit do not require them: an enquiry has no address.
3. **Missing is shown, not refused** (answer 3): an import row still needs only a name and an email or a phone (as
   before); without the rest it imports. The directory and the profile show "Email / Phone / Address missing",
   computed from nulls (`missingDetails`) — no column. A suburb alone counts as an address.
4. **Same person = same email, automatically; same phone = a suggestion** (answer 1, unchanged from ADR 0018 §3).
5. **Same person adds to the profile, never overwrites** (answer 2) — for the import and for Add alike, as
   `contact_upsert` already does for enquiries: a blank field is filled; a field already set keeps its value and the
   timeline records the other value offered (`details_offered`: field, value, by whom, from where). A name is
   replaced only when the profile's is the capture fallback (the email, or "Unknown"). One phone written two ways is
   the same phone (`auPhoneKey`). Consent ticked on Add is recorded only if there is none and no opt-out. Roles are added
   (`manual`), a note becomes a note, a next action fills only a blank one, and the assignee never changes (that is
   `contact:assign`, its own act). The timeline records `details_added` for what was filled. The import's row status
   becomes `updated` with the contact's id; Add says "already a customer — we added what was missing" and links the
   profile only to someone who may see it (`can(actor, 'contact:read', …)`), so it reveals no more than today's
   duplicate message.
6. **Permissions:** filling blanks asks `contact:create` (what the person was doing), not `contact:update` — the
   same footing as an enquiry landing on a contact they cannot see. Writing into a profile reveals nothing from it.

**Alternatives.** Phone as an automatic match (families share phones — the user's earlier decision). Overwrite with
the newest value (an old spreadsheet would undo what an agent typed). Reject import rows without all four (old data
is usually incomplete; the file would bounce). The address as a `property` (a home they live in is not a listing,
and would need geocoding per row).

**Where it lives.** `planFill` (the pure decision, unit-tested) and `addOrFillContact` / `addCustomer` in
`contacts/write-contacts.ts`; the import calls `addOrFillContact` per row (status `updated` for a fill). A merge
carries the loser's address onto a survivor with none. Smoke: "Customer profile (ADR 0079)" and the rewritten
contacts-import check (both need 0080).

**Not done here.** Geocoding imported addresses; a suburb filter on the directory; the assistant's `create_contact`
and `update_contact` cards do not take an address yet.
