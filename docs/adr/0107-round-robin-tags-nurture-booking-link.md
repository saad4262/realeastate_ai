# 0107 — Round-robin, contact tags, a Nurture stage, and each agent's booking link

**Status:** accepted, 2026-11-28 (the user: "start the rest, tell me at 100%", after the 12-step new-lead audit). Migration 0111.

**Context.** Of the user's 12-step new-lead workflow, three parts had nothing to stand on: give the lead to the agents *in turn*,
tag the person "Cold" and move the lead to "Nurture", and email the agent's own booking link. Also "tell the agent" meant a
fixed name, not whoever the run gave the lead to.

**Decision.**
1. **In turn.** Workflow action `assign_in_turn { among: 2–20 members }` (agency-wide workflows only, like assigning): the run
   gives the lead (if it has one) AND the contact to the next active member of the list. The turn is `workflow.turn`, taken
   with one `update … returning` inside the run's transaction, so two runs never get the same turn; a member who left is
   skipped. Frozen into the run as the existing `assign_lead` / `assign_contact` steps. The contact too, so the agent sees
   the person, texts go from their number and the booking link is theirs.
2. **Tell the agent.** Action `message_assigned_agent { subject, body }`: the member an earlier step of this run gave it to,
   else the lead's agent, else the contact's; frozen at run start as `message_colleagues` to that one person. None: the run
   is not made, and says why.
3. **Nurture.** `lead_status` gains `nurture` (before `closed`; open, like the others). The statuses are now written once in
   core (`LEAD_STATUSES`, a browser-safe file every other list uses), and a test holds them equal to `leadStatusEnum.enumValues`.
4. **Tags.** `contact.tags text[]`: free words an agent or a workflow puts on a person, 1–30 characters, at most
   20, the same word once whatever its case. Action `tag_contact { tag }`; added and removed by hand on the contact; a tag
   filter (any case) on the directory, saved lists and `find_contacts` — within one agency's contacts, so no index of its own. Roles stay what they are (what someone is to the agency); a tag is anything else.
5. **Booking link.** `user.booking_url` (https only), set by each person on their Connectors page. Template merge field
   `{{booking_link}}` (email and SMS): the contact's agent's link, else the sender's — the rule a text already uses for its
   number. Nobody's link: that person is skipped ("Their agent has no booking link"), never sent the braces.

**Not done.** A tag as a workflow trigger or condition; round-robin by workload or availability; a booking calendar of our own.
