# 0083 — The full customer profile: each channel its own tab, activity from the agency's own listings

**Status:** accepted, 2026-11-06 (the user's decisions). Mock: `docs/mocks/customer-profile-full.html`. No migration.

**Context.** ADR 0018 and 0079 gave a contact details, leads, emails and notes. SMS and calls were stored but not on
the profile; a person's website activity was visible only to the platform admin (ADR 0051); the admin had no one list
of everybody. The user: "abhi testing phase hai", the privacy question is parked for now.

**Decision.**
1. **Emails, SMS, Calls and Messages are separate tabs and none lists another channel.** Timeline alone shows all of
   them together, as history. **Messages is built empty:** nothing feeds it yet, and no data is invented.
2. **Enquiries reads "Leads"** (the URL key stays `enquiries`, so old links land) with a summary from SQL: status, kind,
   source, first and latest lead, average first reply by a person, open deals. An automatic text or email is not a reply.
3. **SMS tab:** the Texts rule (ADR 0070): an agent sees their own number's texts, owners and admins every number's.
   A text belongs to the contact it names, or, when it names nobody, to the contact whose phone key it shares.
4. **Calls tab:** missed calls and AI call backs from `phone_call`, plus calls logged by hand (`activity`, kind
   `call_logged`, action `contact_call:log`: `note:create`'s rule). A call answered on the agent's mobile never reaches
   Twilio (conditional forwarding, ADR 0071), so a hand log is the only record it can have.
5. **Activity, the user's rule: an agency sees its own listings.** Views and saves on its listings, and searches in a
   suburb where it has a live listing, because a search names a place and not a listing. An agent: the listings they are
   named on (`activity/scope.ts`). The platform admin: this on the customer page, and the whole site on the account.
6. **Listing activity page** (`/listing-activity`, `/my-listing-activity`, `listing_activity:read`): who looked at those
   listings, signed-in people by name and email even if not customers, anonymous visitors a count, the agency's own
   members left out.
7. **A contact is tied to an account** by `contact.user_id`, a lead from that account, or a verified email: "confirmed".
   The same typed email alone also ties, labelled "not confirmed", because sign-up does not confirm an address (ADR 0016).
   A wrong tie can show a stranger's browsing on a profile; it cannot show the profile to the stranger. Never a merge.
8. **Hot, warm and quiet, and "What to do next", are fixed rules** (`contacts/signals.ts`, pure), the reason shown. **The
   summary is the only model call:** on a button, no tools, no figures in (digits masked) or out (rejected), metered as
   `contact:summary`, not stored, labelled "Written by AI". It reaches only the person who pressed it (#7).
9. **Admin:** `/people` lists customers, agency members and website accounts together. The customer page gains address,
   lead summary, SMS, calls and activity; a website account lists the agencies that hold them as a customer. `sms:read`
   and `listing_activity:read` join `PLATFORM_READ`. Every page is logged as before.

**Must change before real customers (the user parked this for testing, it is not closed).** The privacy policy says
activity is kept "to understand what our users look for and to improve the service"; it does not say agencies see it by
name. Naming a signed-in viewer who never contacted the agency needs that wording and a lawful basis (APP 3, 5, 6), and
writing to them from that page needs Spam Act consent. Decide this at go-live: the policy text, or names only for
people who are already the agency's customers.

**Alternatives.** One "Conversations" tab (the user: never mixed). Full search history to agencies (the user: own
listings). A stored engagement score (a column to keep right; the rules read live facts). Recording answered calls by
routing all calls through Twilio (changes the agent's number setup and needs Twilio, which is blocked).

**Not done here.** Per-lead first-reply time; a messaging channel behind Messages; adding a viewer as a customer from
Listing activity; `phone_call` has no `contact_id` index (the read uses the agency's missed-call index; add one if a
large agency shows up slow in smoke).
