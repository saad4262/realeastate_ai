# 0061 — Three more contact roles: prospect, past client, referral partner

**Status:** accepted, 2026-10-27. ROADMAP Phase 1.5. Migration 0067.

**Context.** The brief's #3 lists buyers, sellers, landlords, tenants, investors, prospects, past clients
and referral partners. The last three had no role, so an agency could not tag, filter, import or automate
on them.

**Decision.**
1. `contact_role_kind` gains `prospect`, `past_client`, `referral_partner` (labels Prospect, Past client,
   Referral partner). Everything reads `CONTACT_ROLES`, so the contact form, the directory's role filter,
   the assistant's find/create/update tools, the workflow condition `contact.role` and the import all take
   them with no other change.
2. The import reads the words exports use: "past client(s)", "former/previous client", "referral",
   "referrer", "referral partner/source", "potential client". An unknown word's error lists every role.
3. **None of them is a client role for marketing consent** (the user's strict Spam Act reading, ADR 0060
   decision 4): `CLIENT_ROLES` stays seller, landlord, tenant. A past client is emailed only with recorded
   consent or an enquiry in the last 24 months.
4. A role is still a tag a person sets; nothing infers one (e.g. "sold through us → past client") yet.

**Not done.** Inferring past clients from settled sales (Phase 2, transactions); a referral's source
contact; past-client automations (Phase 4).
