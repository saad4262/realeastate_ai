# 0087 — An agent's own Twilio, and the agency's office line

**Status:** accepted, 2026-11-07 (the user's three answers below). Amends ADR 0070 §1–3 and ADR 0072's
SIP trunk. Migration 0092 (additive, NOT applied: `.env.local` is production). Built in two parts:
part 1 (this change) is the agent's own Twilio; part 2 is the office line.

**Context.** ADR 0070 gave each agency one Twilio account, and the owner bought every agent's number on
it. The user wants an agent to be able to bring their own Twilio, with their own keys, bills and number,
while the agency keeps its own account.

**The user's decisions (2026-11-07).**
1. The agency keeps its Twilio. It holds the agency's **main office line** (exactly one) and may hold
   more numbers that the agency gives to agents, as today.
2. An agent's texts on their own number are read by the agent **and** the agency (owners, admins).
3. An agent who leaves keeps their number (it is on their own Twilio). The conversations from their
   time at the agency stay with the agency.

**Decision.**
1. `phone_account` gains `owner_user_id`: null is the agency's account (one per agency), set is that
   member's own account (one per member per agency). Two partial unique indexes replace the old
   unique `agency_id`. `phone_number` gains `account_id`: the account the number lives on, and the one
   whose key every Twilio call about it uses (texts, missed-call texts, bulk SMS, caller ID, the
   forwarding test, AI calls). Existing numbers are backfilled to their agency's account.
2. An agent connects their own Twilio on My phone with `phone:own` (themselves only — `ownerId` is
   theirs). An owner or admin cannot see, use or disconnect it: `phone:manage` covers the agency's
   account only. The agent's own Twilio checks its own AU mobile bundle, the same way (hourly, or
   "Check now").
3. With their own account approved, the agent buys a number on it, or **uses one they already have**
   on it (listed from Twilio, webhooks pointed here). Using an existing number is what lets an agent
   bring their number to a new agency (decision 3). Still one active number per agent: an agent who
   holds one of the agency's numbers asks for it to be released first.
4. Leaving (`removeMember`): numbers on the agent's own account are marked `left` and their account
   row is deleted (the key is forgotten, in the same transaction; no Twilio call). The texts and calls
   stay on the agency's record. Twilio still points the number here until the agent uses it elsewhere;
   the webhooks already ignore a number that is not active. A restore within 30 days does not bring
   the key back: the agent connects again. The agency's own numbers given to the agent are untouched.
5. Disconnecting one's own Twilio marks its numbers `released` here and does not touch them in Twilio
   (they are the agent's). Releasing is never offered for another person's account.
6. Bulk SMS's "agency number" (ADR 0074 rule 1, texts to contacts nobody is assigned) is a number on
   the agency's account only — picked or fallen back to. Those texts are the agency's, so they never
   go out from, or bill, an agent's own Twilio. An agent's own number still texts that agent's contacts.
7. AI calls (ADR 0072): the SIP trunk belongs to the account the number is on. The owner's "Set up AI
   calls" covers the agency's numbers; an agent sets up their own number on My phone.
8. Part 2, the office line: a number on the agency's account with no agent (`user_id` null, `purpose`
   `office`, one per agency). Its texts are read and answered by owners and admins; its missed calls
   are the agency's. Not in this change.

**Alternatives.** The agency's account only (ADR 0070): the user wants agents to own their numbers. The
agent's account only: most agents will not set up Twilio, so the agency must still be able to give them
a number.

**Consequences.** Each agent with their own Twilio needs their own Twilio account, card and AU bundle (ID
or business documents, days to approve): the agency's numbers stay the easy way. More encrypted secrets
are held, one per agent who connects. The Spam Act duties stay with the agency whose name the texts are
sent in, whoever pays Twilio. `phone:repoint` and the hourly KYC check walk every account, not every
agency.
