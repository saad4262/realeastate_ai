# 0015 — Agents are emailed their invite link and their leads

**Status:** accepted, 2026-10-02.

**Context.** Outbound mail works now (Resend, the alert digest), but an agent got none:
the claim link had to be copied and sent by hand, and an enquiry sat in the inbox until
somebody happened to look.

**Decision.**
1. Invite and resend mail the claim link to the invited address
   (`emailAgentInvite`). The link stays on screen with Copy; the toast says whether the
   email went. A failed send never fails the invite.
2. A new enquiry mails the active agents named on its listing; with none, the agency's
   owners and admins (`notifyNewLead`). An assignment mails the assignee, unless they
   assigned it to themselves (`notifyLeadAssigned`). Offers keep their own notice.
3. Every recipient is judged by the same `can()` the console uses to show the lead.
   An email is another way of showing it.
4. Sent with `after()`, after the write and outside it. A mail outage costs an email,
   never a lead. All three are transactional mail with no unsubscribe header, like the
   offer notice.

**Not done.** There is no per-agent setting to turn these off, and no digest. Add those
if agents ask.
