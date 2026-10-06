import { describe, expect, it } from 'vitest';
import { can, type Actor } from './permissions';

const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';
const listingA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const listingB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('can()', () => {
  it('denies Agency A agent editing Agency B listing', () => {
    const actor: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
      listingAgentOf: [listingA],
    };
    expect(
      can(actor, 'listing:edit', {
        type: 'listing',
        id: listingB,
        agencyId: agencyB,
      }),
    ).toBe(false);
  });

  it('allows listing agent to edit own agency listing', () => {
    const actor: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
      listingAgentOf: [listingA],
    };
    expect(
      can(actor, 'listing:edit', {
        type: 'listing',
        id: listingA,
        agencyId: agencyA,
      }),
    ).toBe(true);
  });

  it('allows owner to edit any listing in agency without being listing_agent', () => {
    const actor: Actor = {
      userId: 'owner-a',
      agencyId: agencyA,
      membershipRole: 'owner',
    };
    expect(
      can(actor, 'listing:edit', {
        type: 'listing',
        id: listingA,
        agencyId: agencyA,
      }),
    ).toBe(true);
  });

  it('denies agent team:manage', () => {
    const actor: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
    };
    expect(can(actor, 'team:manage', { type: 'team', agencyId: agencyA })).toBe(false);
  });

  it('allows admin agency:billing', () => {
    const actor: Actor = {
      userId: 'admin-a',
      agencyId: agencyA,
      membershipRole: 'admin',
    };
    expect(can(actor, 'agency:billing', { type: 'agency', agencyId: agencyA })).toBe(true);
  });

  it('allows owner console:agency and denies agent', () => {
    const owner: Actor = {
      userId: 'owner-a',
      agencyId: agencyA,
      membershipRole: 'owner',
    };
    const agent: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
    };
    expect(can(owner, 'console:agency', { type: 'console' })).toBe(true);
    expect(can(agent, 'console:agency', { type: 'console' })).toBe(false);
  });

  it('allows agent console:agent and denies user without membership', () => {
    const agent: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
    };
    const orphan: Actor = { userId: 'orphan' };
    expect(can(agent, 'console:agent', { type: 'console' })).toBe(true);
    expect(can(orphan, 'console:agent', { type: 'console' })).toBe(false);
  });

  it('denies Agency B admin from console:agency when acting without own membership context', () => {
    // console:agency is identity+membership based (not cross-resource); orphan still denied
    const noAgency: Actor = {
      userId: 'admin-b',
      membershipRole: 'admin',
    };
    expect(can(noAgency, 'console:agency', { type: 'console' })).toBe(false);
  });

  /**
   * The lead inbox, and the one row in it that is not ordinary business.
   *
   * Two actions rather than one, because the answer differs by WHAT is being
   * read and `can()` cannot see a row's kind. Splitting it is what keeps the
   * decision in this file instead of becoming a role check inside a query,
   * which non-negotiable #2 forbids.
   */
  describe('the lead inbox', () => {
    const inbox = { type: 'lead', agencyId: agencyA };
    const owner: Actor = { userId: 'owner-a', agencyId: agencyA, membershipRole: 'owner' };
    const admin: Actor = { userId: 'admin-a', agencyId: agencyA, membershipRole: 'admin' };
    const agent: Actor = { userId: 'agent-a', agencyId: agencyA, membershipRole: 'agent' };
    const assistant: Actor = { userId: 'asst-a', agencyId: agencyA, membershipRole: 'assistant' };

    it("denies another agency's owner the whole inbox", () => {
      const outsider: Actor = { userId: 'owner-b', agencyId: agencyB, membershipRole: 'owner' };
      expect(can(outsider, 'lead:read', inbox)).toBe(false);
      expect(can(outsider, 'lead:read_offer', inbox)).toBe(false);
    });

    it('lets any active member open the inbox', () => {
      // An enquiry is ordinary business and the agent working that campaign is
      // the one who has to answer it. Admin-only here would leave the agent
      // desk with an inbox it cannot open.
      for (const actor of [owner, admin, agent, assistant]) {
        expect(can(actor, 'lead:read', inbox)).toBe(true);
      }
    });

    it('lets only the people who run the agency read a private offer', () => {
      /**
       * The one that matters. An offer is a named person's financial intent
       * about somebody's home, with contact details attached. This has to agree
       * with `agencyNotificationRecipients`, which mails owners and admins only
       * — if the two ever disagree, somebody is either emailed something they
       * cannot open or can open something they were never told about.
       */
      expect(can(owner, 'lead:read_offer', inbox)).toBe(true);
      expect(can(admin, 'lead:read_offer', inbox)).toBe(true);
      expect(can(agent, 'lead:read_offer', inbox)).toBe(false);
      expect(can(assistant, 'lead:read_offer', inbox)).toBe(false);
    });

    it('refuses an actor with no membership at all', () => {
      const orphan: Actor = { userId: 'orphan' };
      expect(can(orphan, 'lead:read', inbox)).toBe(false);
      expect(can(orphan, 'lead:read_offer', inbox)).toBe(false);
    });

    it('is strictly narrower for offers than for the inbox', () => {
      // Whoever may read an offer may always open the inbox. The reverse is the
      // whole point and must not quietly become true.
      for (const actor of [owner, admin, agent, assistant]) {
        if (can(actor, 'lead:read_offer', inbox)) {
          expect(can(actor, 'lead:read', inbox)).toBe(true);
        }
      }
      expect(can(agent, 'lead:read', inbox)).toBe(true);
      expect(can(agent, 'lead:read_offer', inbox)).toBe(false);
    });

    describe('triage', () => {
      const lead = (assignedTo?: string) => ({
        type: 'lead',
        id: 'lead-1',
        agencyId: agencyA,
        ...(assignedTo ? { ownerId: assignedTo } : {}),
      });

      it('lets an admin move any lead, assigned or not', () => {
        for (const actor of [owner, admin]) {
          expect(can(actor, 'lead:update', lead())).toBe(true);
          expect(can(actor, 'lead:update', lead('agent-a'))).toBe(true);
        }
      });

      it('lets a member move only the lead assigned to them', () => {
        expect(can(agent, 'lead:update', lead('agent-a'))).toBe(true);
        expect(can(agent, 'lead:update', lead('asst-a'))).toBe(false);
        // Unassigned is nobody's job yet, so not this agent's to close.
        expect(can(agent, 'lead:update', lead())).toBe(false);
        expect(can(assistant, 'lead:update', lead('agent-a'))).toBe(false);
      });

      it("refuses another agency, even an owner, even one 'assigned' by id", () => {
        const outsider: Actor = { userId: 'agent-a', agencyId: agencyB, membershipRole: 'owner' };
        // Same user id as the assignee: tenancy is checked before ownership.
        expect(can(outsider, 'lead:update', lead('agent-a'))).toBe(false);
        expect(can(outsider, 'lead:assign', lead())).toBe(false);
      });

      it('refuses a former member whose membership is gone', () => {
        const left: Actor = { userId: 'agent-a', agencyId: agencyA };
        expect(can(left, 'lead:update', lead('agent-a'))).toBe(false);
      });

      it('lets only admins assign', () => {
        expect(can(owner, 'lead:assign', lead())).toBe(true);
        expect(can(admin, 'lead:assign', lead())).toBe(true);
        expect(can(agent, 'lead:assign', lead('agent-a'))).toBe(false);
        expect(can(assistant, 'lead:assign', lead())).toBe(false);
      });
    });
  });

  /**
   * The approval step (ADR 0014): agents submit, owners and admins publish.
   */
  describe('submitting and publishing a listing', () => {
    const resource = { type: 'listing', id: listingA, agencyId: agencyA };
    const named: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
      listingAgentOf: [listingA],
    };
    const owner: Actor = { userId: 'owner-a', agencyId: agencyA, membershipRole: 'owner' };
    const admin: Actor = { userId: 'admin-a', agencyId: agencyA, membershipRole: 'admin' };

    it('lets the named agent submit but never publish', () => {
      expect(can(named, 'listing:submit', resource)).toBe(true);
      expect(can(named, 'listing:publish', resource)).toBe(false);
    });

    it('lets owners and admins publish', () => {
      expect(can(owner, 'listing:publish', resource)).toBe(true);
      expect(can(admin, 'listing:publish', resource)).toBe(true);
    });

    it('refuses submit to an agent not named on the listing, and publish across agencies', () => {
      const other: Actor = { userId: 'agent-x', agencyId: agencyA, membershipRole: 'agent' };
      expect(can(other, 'listing:submit', resource)).toBe(false);
      const outsider: Actor = { userId: 'owner-b', agencyId: agencyB, membershipRole: 'owner' };
      expect(can(outsider, 'listing:publish', resource)).toBe(false);
      expect(can(outsider, 'listing:submit', resource)).toBe(false);
    });
  });

  /**
   * An agent's leads (ADR 0014): theirs, or their listing's.
   */
  describe("an agent's view of one lead", () => {
    const named: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
      listingAgentOf: [listingA],
    };
    const lead = (over: { ownerId?: string; listingId?: string | null } = {}) => ({
      type: 'lead',
      id: 'lead-1',
      agencyId: agencyA,
      ...over,
    });

    it('reads a lead assigned to them, from any listing', () => {
      expect(can(named, 'lead:read', lead({ ownerId: 'agent-a', listingId: listingB }))).toBe(true);
    });

    it("reads their own listing's lead, assigned to anyone or no one", () => {
      expect(can(named, 'lead:read', lead({ listingId: listingA }))).toBe(true);
      expect(can(named, 'lead:read', lead({ listingId: listingA, ownerId: 'agent-x' }))).toBe(true);
    });

    it("does not read another agent's lead, or one with no listing", () => {
      expect(can(named, 'lead:read', lead({ listingId: listingB }))).toBe(false);
      expect(can(named, 'lead:read', lead({ listingId: listingB, ownerId: 'agent-x' }))).toBe(false);
      expect(can(named, 'lead:read', lead({ listingId: null }))).toBe(false);
    });

    it('works an unassigned lead from their listing, but not one assigned to someone else', () => {
      expect(can(named, 'lead:update', lead({ listingId: listingA }))).toBe(true);
      expect(can(named, 'lead:update', lead({ listingId: listingA, ownerId: 'agent-x' }))).toBe(false);
    });

    it('never reads the whole agency, which admins do', () => {
      expect(can(named, 'lead:read_all', { type: 'lead', agencyId: agencyA })).toBe(false);
      const owner: Actor = { userId: 'owner-a', agencyId: agencyA, membershipRole: 'owner' };
      expect(can(owner, 'lead:read_all', { type: 'lead', agencyId: agencyA })).toBe(true);
      expect(can(owner, 'lead:read', lead({ listingId: listingB, ownerId: 'agent-x' }))).toBe(true);
    });
  });

  /**
   * Recording a sale.
   *
   * `listing:sell` shares publish's rule and is deliberately a separate action:
   * a published ad can be withdrawn, while a sale price becomes a permanent
   * line in the public history of an address. These tests are what will fail
   * if somebody later collapses the two cases back together, and the pair of
   * "same answer" assertions is what says the sharing is on purpose.
   */
  describe('recording a sale', () => {
    const sellable = { type: 'listing', id: listingA, agencyId: agencyA };

    it("denies Agency A's agent recording a sale on Agency B's listing", () => {
      const actor: Actor = {
        userId: 'agent-a',
        agencyId: agencyA,
        membershipRole: 'agent',
        listingAgentOf: [listingA, listingB],
      };
      // Named on the listing is not enough when the listing is not theirs.
      expect(can(actor, 'listing:sell', { type: 'listing', id: listingB, agencyId: agencyB })).toBe(
        false,
      );
    });

    it('denies an agent who is not named on the listing', () => {
      const actor: Actor = { userId: 'agent-a', agencyId: agencyA, membershipRole: 'agent' };
      expect(can(actor, 'listing:sell', sellable)).toBe(false);
    });

    it('allows the named listing agent and the agency owner', () => {
      const named: Actor = {
        userId: 'agent-a',
        agencyId: agencyA,
        membershipRole: 'agent',
        listingAgentOf: [listingA],
      };
      const owner: Actor = { userId: 'owner-a', agencyId: agencyA, membershipRole: 'owner' };
      expect(can(named, 'listing:sell', sellable)).toBe(true);
      expect(can(owner, 'listing:sell', sellable)).toBe(true);
    });

    it('answers the same as edit, for every role — not as publish any more', () => {
      /**
       * It used to mirror publish. ADR 0014 made publish the approval step,
       * admins only; recording a sale stayed with whoever works the listing,
       * because it ends a campaign rather than starting one in public.
       */
      const roles = ['owner', 'admin', 'agent', 'assistant', 'property_manager', 'read_only'] as const;
      for (const membershipRole of roles) {
        for (const listingAgentOf of [[], [listingA]]) {
          const actor: Actor = { userId: 'u', agencyId: agencyA, membershipRole, listingAgentOf };
          expect(can(actor, 'listing:sell', sellable)).toBe(can(actor, 'listing:edit', sellable));
        }
      }
    });

    it('refuses an actor with no membership at all', () => {
      expect(can({ userId: 'orphan' }, 'listing:sell', sellable)).toBe(false);
    });
  });

  /**
   * Scheduled searches belong to a person, not to an agency.
   *
   * This is the first resource in the system with that shape, and these tests
   * are what stop the next person from "fixing" the missing `isAgencyAdmin`
   * check in those two cases. See docs/adr/0011.
   */
  describe('scheduled searches', () => {
    const buyer: Actor = { userId: 'buyer-1' };
    const otherBuyer: Actor = { userId: 'buyer-2' };
    const scheduleOfBuyer1 = { type: 'schedule', id: 'sched-1', ownerId: 'buyer-1' };

    it('allows an account with no agency to create one, and refuses a signed-out actor', () => {
      expect(can(buyer, 'schedule:create', { type: 'schedule' })).toBe(true);
      expect(can({ userId: '' }, 'schedule:create', { type: 'schedule' })).toBe(false);
    });

    it('allows the owner to read their own schedule and denies another account', () => {
      expect(can(buyer, 'schedule:read', scheduleOfBuyer1)).toBe(true);
      expect(can(otherBuyer, 'schedule:read', scheduleOfBuyer1)).toBe(false);
    });

    it('allows the owner to manage their own schedule and denies another account', () => {
      expect(can(buyer, 'schedule:manage', scheduleOfBuyer1)).toBe(true);
      expect(can(otherBuyer, 'schedule:manage', scheduleOfBuyer1)).toBe(false);
    });

    /**
     * The interesting one. Everywhere else in this file an agency owner is the
     * most powerful actor there is; here they are nobody. A buyer's saved
     * search is not agency data, and no role grants it.
     */
    it('denies an agency owner any access to a consumer schedule', () => {
      const owner: Actor = { userId: 'owner-a', agencyId: agencyA, membershipRole: 'owner' };

      expect(can(owner, 'schedule:read', scheduleOfBuyer1)).toBe(false);
      expect(can(owner, 'schedule:manage', scheduleOfBuyer1)).toBe(false);
      // ...and still yes to their own.
      expect(can(owner, 'schedule:read', { type: 'schedule', ownerId: 'owner-a' })).toBe(true);
    });

    /**
     * A resource with no owner must not match an actor with no id. Both being
     * `undefined` compares equal, which would hand every unowned row to every
     * signed-out caller.
     */
    it('does not let an ownerless resource match an actorless request', () => {
      expect(can({ userId: '' }, 'schedule:read', { type: 'schedule' })).toBe(false);
      expect(can(buyer, 'schedule:read', { type: 'schedule' })).toBe(false);
    });
  });
});

/**
 * Contacts (ADR 0018), with the user's rules of 2026-10-05: an agent fully
 * edits contacts assigned to them; one they meet only through a lead is notes
 * only; assistants and property managers follow the agent rule; read-only
 * members view and write nothing.
 */
describe('contacts', () => {
  const contactId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const member = (userId: string, membershipRole: Actor['membershipRole']): Actor => ({
    userId,
    agencyId: agencyA,
    membershipRole,
  });
  const owner = member('owner', 'owner');
  const agent = member('agent', 'agent');
  const other = member('other', 'agent');
  const assistant = member('assistant', 'assistant');
  const pm = member('pm', 'property_manager');
  const viewer = member('viewer', 'read_only');
  const rivalOwner: Actor = { userId: 'rival', agencyId: agencyB, membershipRole: 'owner' };

  const theirs = (userId: string) => ({ type: 'contact', id: contactId, agencyId: agencyA, ownerId: userId });
  const viaLead = (userId: string) => ({ type: 'contact', id: contactId, agencyId: agencyA, leadAssigneeIds: [userId] });
  const viaListing = (userId: string) => ({ type: 'contact', id: contactId, agencyId: agencyA, listingAgentIds: [userId] });
  const nobodys = { type: 'contact', id: contactId, agencyId: agencyA };
  const directory = { type: 'contact', agencyId: agencyA };

  it("never crosses agencies, even for another agency's owner", () => {
    for (const action of ['contact:read', 'contact:update', 'contact:assign', 'contact:merge', 'note:create'] as const) {
      expect(can(rivalOwner, action, { ...theirs('rival'), agencyId: agencyA })).toBe(false);
    }
    expect(can(rivalOwner, 'contact:read', directory)).toBe(false);
  });

  it('lets admins see, edit, assign and merge every contact in their agency', () => {
    for (const action of ['contact:read', 'contact:read_all', 'contact:update', 'contact:assign', 'contact:merge', 'note:create'] as const) {
      expect(can(owner, action, nobodys)).toBe(true);
    }
  });

  it('lets an agent fully edit a contact assigned to them', () => {
    expect(can(agent, 'contact:read', theirs('agent'))).toBe(true);
    expect(can(agent, 'contact:update', theirs('agent'))).toBe(true);
    expect(can(agent, 'note:create', theirs('agent'))).toBe(true);
  });

  it('gives notes only on a contact met through a lead or a listing', () => {
    for (const r of [viaLead('agent'), viaListing('agent')]) {
      expect(can(agent, 'contact:read', r)).toBe(true);
      expect(can(agent, 'note:create', r)).toBe(true);
      expect(can(agent, 'contact:update', r)).toBe(false);
    }
  });

  it("does not show an agent somebody else's contact, or nobody's", () => {
    expect(can(other, 'contact:read', theirs('agent'))).toBe(false);
    expect(can(other, 'contact:read', viaLead('agent'))).toBe(false);
    expect(can(agent, 'contact:read', nobodys)).toBe(false);
    expect(can(agent, 'note:create', nobodys)).toBe(false);
  });

  it('never lets a non-admin assign, merge or read the whole book', () => {
    for (const a of [agent, assistant, pm, viewer]) {
      expect(can(a, 'contact:assign', theirs(a.userId))).toBe(false);
      expect(can(a, 'contact:merge', theirs(a.userId))).toBe(false);
      expect(can(a, 'contact:read_all', directory)).toBe(false);
    }
  });

  it('treats assistants and property managers exactly as agents', () => {
    for (const a of [assistant, pm]) {
      expect(can(a, 'contact:create', directory)).toBe(true);
      expect(can(a, 'contact:update', theirs(a.userId))).toBe(true);
      expect(can(a, 'contact:update', viaLead(a.userId))).toBe(false);
      expect(can(a, 'note:create', viaLead(a.userId))).toBe(true);
      expect(can(a, 'contact:read', nobodys)).toBe(false);
    }
  });

  it('lets a read-only member view what an agent would, and write nothing', () => {
    expect(can(viewer, 'contact:read', directory)).toBe(true);
    expect(can(viewer, 'contact:read', theirs('viewer'))).toBe(true);
    expect(can(viewer, 'contact:read', viaLead('viewer'))).toBe(true);
    expect(can(viewer, 'contact:create', directory)).toBe(false);
    expect(can(viewer, 'contact:update', theirs('viewer'))).toBe(false);
    expect(can(viewer, 'note:create', theirs('viewer'))).toBe(false);
    expect(can(viewer, 'note:manage', { type: 'note', id: 'n', agencyId: agencyA, ownerId: 'viewer' })).toBe(false);
  });

  it('archives on the edit rule: the assignee or an admin, never read-only', () => {
    expect(can(agent, 'contact:archive', theirs('agent'))).toBe(true);
    expect(can(agent, 'contact:archive', viaLead('agent'))).toBe(false);
    expect(can(owner, 'contact:archive', nobodys)).toBe(true);
    expect(can(viewer, 'contact:archive', theirs('viewer'))).toBe(false);
    expect(can(rivalOwner, 'contact:archive', { ...nobodys })).toBe(false);
  });

  it('shows a private note to admins and its author only', () => {
    const privateNote = { type: 'note', id: 'n-p', agencyId: agencyA, ownerId: 'agent' };
    expect(can(owner, 'note:read_private', privateNote)).toBe(true);
    expect(can(agent, 'note:read_private', privateNote)).toBe(true);
    expect(can(other, 'note:read_private', privateNote)).toBe(false);
    expect(can(viewer, 'note:read_private', privateNote)).toBe(false);
    expect(can(rivalOwner, 'note:read_private', privateNote)).toBe(false);
    // Asked about the agency as a whole: only admins see every private note.
    expect(can(owner, 'note:read_private', { type: 'note', agencyId: agencyA })).toBe(true);
    expect(can(agent, 'note:read_private', { type: 'note', agencyId: agencyA })).toBe(false);
  });

  it('lets a note be changed by its author or an admin only', () => {
    const note = { type: 'note', id: 'n-1', agencyId: agencyA, ownerId: 'agent' };
    expect(can(agent, 'note:manage', note)).toBe(true);
    expect(can(other, 'note:manage', note)).toBe(false);
    expect(can(owner, 'note:manage', note)).toBe(true);
    expect(can(rivalOwner, 'note:manage', note)).toBe(false);
  });

  it('refuses an actor with no membership, and an id-less resource with no owner', () => {
    const outsider: Actor = { userId: 'x' };
    expect(can(outsider, 'contact:read', directory)).toBe(false);
    expect(can(outsider, 'contact:create', directory)).toBe(false);
    // An empty assignee must never match an actor whose id is also empty.
    expect(can({ ...agent, userId: '' }, 'contact:update', { ...nobodys, ownerId: '' })).toBe(false);
  });
});

/** Appointments (ADR 0019): admin all, agent own/assigned, read-only view only. */
describe('appointments', () => {
  const m = (userId: string, membershipRole: Actor['membershipRole']): Actor => ({ userId, agencyId: agencyA, membershipRole });
  const owner = m('owner', 'owner');
  const agent = m('agent', 'agent');
  const other = m('other', 'agent');
  const viewer = m('viewer', 'read_only');
  const rival: Actor = { userId: 'rival', agencyId: agencyB, membershipRole: 'owner' };
  const appt = (ownerId: string | null, createdBy: string | null = null) => ({
    type: 'appointment',
    id: 'appt-1',
    agencyId: agencyA,
    ...(ownerId ? { ownerId } : {}),
    createdBy,
  });
  const calendar = { type: 'appointment', agencyId: agencyA };

  it('shows an agent their own and the ones they booked — never another agent’s', () => {
    expect(can(agent, 'appointment:read', appt('agent'))).toBe(true);
    expect(can(agent, 'appointment:read', appt('other', 'agent'))).toBe(true);
    expect(can(other, 'appointment:read', appt('agent'))).toBe(false);
    expect(can(agent, 'appointment:read', appt(null))).toBe(false);
  });

  it('lets admins see and change the whole calendar, and nobody cross agencies', () => {
    expect(can(owner, 'appointment:read', appt('agent'))).toBe(true);
    expect(can(owner, 'appointment:update', appt('agent'))).toBe(true);
    expect(can(owner, 'appointment:read_all', calendar)).toBe(true);
    expect(can(rival, 'appointment:read', appt('rival'))).toBe(false);
    expect(can(rival, 'appointment:update', appt('rival'))).toBe(false);
  });

  it('lets only the assigned agent (or an admin) change one — not whoever booked it for them', () => {
    expect(can(agent, 'appointment:update', appt('agent'))).toBe(true);
    expect(can(agent, 'appointment:update', appt('other', 'agent'))).toBe(false);
    expect(can(other, 'appointment:update', appt('agent'))).toBe(false);
  });

  it('gives read-only members their calendar to look at and nothing to change', () => {
    expect(can(viewer, 'appointment:read', calendar)).toBe(true);
    expect(can(viewer, 'appointment:read', appt('viewer'))).toBe(true);
    expect(can(viewer, 'appointment:create', calendar)).toBe(false);
    expect(can(viewer, 'appointment:update', appt('viewer'))).toBe(false);
  });

  it('keeps booking for somebody else, and the whole calendar, to admins', () => {
    for (const a of [agent, viewer]) {
      expect(can(a, 'appointment:assign', calendar)).toBe(false);
      expect(can(a, 'appointment:read_all', calendar)).toBe(false);
    }
    expect(can(agent, 'appointment:create', calendar)).toBe(true);
  });
});

/** Integrations (ADR 0020). */
describe('integrations', () => {
  const m = (userId: string, membershipRole: Actor['membershipRole']): Actor => ({ userId, agencyId: agencyA, membershipRole });
  const owner = m('owner', 'owner');
  const agent = m('agent', 'agent');
  const other = m('other', 'agent');
  const viewer = m('viewer', 'read_only');
  const rival: Actor = { userId: 'rival', agencyId: agencyB, membershipRole: 'owner' };
  const mine = (userId: string) => ({ type: 'integration', agencyId: agencyA, integrationOwnerType: 'user' as const, ownerId: userId });
  const agencyAcct = { type: 'integration', agencyId: agencyA, integrationOwnerType: 'agency' as const, ownerId: agencyA };

  it("lets an agent manage and use only their own account — never another's", () => {
    expect(can(agent, 'integration:manage', mine('agent'))).toBe(true);
    expect(can(agent, 'integration:use', mine('agent'))).toBe(true);
    expect(can(agent, 'integration:read', mine('other'))).toBe(false);
    expect(can(agent, 'integration:use', mine('other'))).toBe(false);
    expect(can(agent, 'integration:manage', mine('other'))).toBe(false);
  });

  it("does not let even an admin use or manage a person's own account", () => {
    expect(can(owner, 'integration:use', mine('agent'))).toBe(false);
    expect(can(owner, 'integration:manage', mine('agent'))).toBe(false);
  });

  it('keeps agency accounts to admins to manage, and lets members see and use them', () => {
    expect(can(owner, 'integration:manage', agencyAcct)).toBe(true);
    expect(can(agent, 'integration:manage', agencyAcct)).toBe(false);
    expect(can(agent, 'integration:read', agencyAcct)).toBe(true);
    expect(can(agent, 'integration:use', agencyAcct)).toBe(true);
  });

  it('never crosses agencies, even for an owner', () => {
    expect(can(rival, 'integration:read', agencyAcct)).toBe(false);
    expect(can(rival, 'integration:use', agencyAcct)).toBe(false);
    expect(can(rival, 'integration:manage', { ...agencyAcct, agencyId: agencyB })).toBe(false);
  });

  it('gives read-only members nothing to connect', () => {
    expect(can(viewer, 'integration:manage', mine('viewer'))).toBe(false);
    expect(can(viewer, 'integration:read', mine('viewer'))).toBe(true);
  });

  it('refuses an agency-level resource whose owner is not the agency', () => {
    expect(can(owner, 'integration:manage', { ...agencyAcct, ownerId: agencyB })).toBe(false);
    expect(can(agent, 'integration:use', { ...agencyAcct, ownerId: agencyB })).toBe(false);
  });
});

/** Skills (ADR 0021). */
describe('skills', () => {
  const m = (userId: string, membershipRole: Actor['membershipRole']): Actor => ({ userId, agencyId: agencyA, membershipRole });
  const owner = m('owner', 'owner');
  const agent = m('agent', 'agent');
  const other = m('other', 'agent');
  const viewer = m('viewer', 'read_only');
  const rival: Actor = { userId: 'rival', agencyId: agencyB, membershipRole: 'owner' };
  const copy = (ownerId: string) => ({ type: 'agent_skill', id: 'as-1', agencyId: agencyA, ownerId });

  it('lets any member read the platform library and their own agency’s, never another agency’s', () => {
    expect(can(agent, 'skill:read', { type: 'skill' })).toBe(true);
    expect(can(agent, 'skill:read', { type: 'skill', agencyId: agencyA })).toBe(true);
    expect(can(agent, 'skill:read', { type: 'skill', agencyId: agencyB })).toBe(false);
    expect(can({ userId: 'x' }, 'skill:read', { type: 'skill' })).toBe(false);
  });

  it('keeps curating the library to admins', () => {
    expect(can(owner, 'skill:curate', { type: 'skill', agencyId: agencyA })).toBe(true);
    expect(can(agent, 'skill:curate', { type: 'skill', agencyId: agencyA })).toBe(false);
    expect(can(rival, 'skill:curate', { type: 'skill', agencyId: agencyA })).toBe(false);
  });

  it("lets an agent manage only their own copy — not even an admin manages someone else's", () => {
    expect(can(agent, 'agent_skill:manage', copy('agent'))).toBe(true);
    expect(can(other, 'agent_skill:manage', copy('agent'))).toBe(false);
    expect(can(other, 'agent_skill:read', copy('agent'))).toBe(false);
    expect(can(owner, 'agent_skill:read', copy('agent'))).toBe(false);
    expect(can(owner, 'agent_skill:manage', copy('agent'))).toBe(false);
  });

  it('gives read-only members nothing to run', () => {
    expect(can(viewer, 'agent_skill:manage', copy('viewer'))).toBe(false);
  });
});

/** Template email (ADR 0022). */
describe('template email', () => {
  const m = (userId: string, membershipRole: Actor['membershipRole']): Actor => ({ userId, agencyId: agencyA, membershipRole });
  const owner = m('owner', 'owner');
  const agent = m('agent', 'agent');
  const other = m('other', 'agent');
  const viewer = m('viewer', 'read_only');
  const rival: Actor = { userId: 'rival', agencyId: agencyB, membershipRole: 'owner' };
  const tpl = (ownerId: string) => ({ type: 'email_template', id: 't-1', agencyId: agencyA, ownerId });
  const batch = (ownerId: string) => ({ type: 'email_batch', id: 'b-1', agencyId: agencyA, ownerId });

  it('lets agents draft and edit their own draft, and only admins approve', () => {
    expect(can(agent, 'email_template:draft', { type: 'email_template', agencyId: agencyA })).toBe(true);
    expect(can(agent, 'email_template:draft', tpl('agent'))).toBe(true);
    expect(can(other, 'email_template:draft', tpl('agent'))).toBe(false);
    expect(can(agent, 'email_template:approve', tpl('agent'))).toBe(false);
    expect(can(owner, 'email_template:approve', tpl('agent'))).toBe(true);
    expect(can(rival, 'email_template:approve', tpl('agent'))).toBe(false);
    expect(can(viewer, 'email_template:draft', { type: 'email_template', agencyId: agencyA })).toBe(false);
  });

  it("shows an agent only their own batches; admins the agency's", () => {
    expect(can(agent, 'email_batch:read', batch('agent'))).toBe(true);
    expect(can(other, 'email_batch:read', batch('agent'))).toBe(false);
    expect(can(owner, 'email_batch:read', batch('agent'))).toBe(true);
    expect(can(rival, 'email_batch:read', batch('agent'))).toBe(false);
  });

  it('lets only the agent who prepared it send it — not even an admin', () => {
    expect(can(agent, 'email_batch:send', batch('agent'))).toBe(true);
    expect(can(owner, 'email_batch:send', batch('agent'))).toBe(false);
    expect(can(other, 'email_batch:send', batch('agent'))).toBe(false);
    expect(can(owner, 'email_batch:cancel', batch('agent'))).toBe(true);
    expect(can(viewer, 'email_batch:create', { type: 'email_batch', agencyId: agencyA })).toBe(false);
  });
});

describe('assistant (ADR 0025)', () => {
  const m = (userId: string, membershipRole: Actor['membershipRole']): Actor => ({ userId, agencyId: agencyA, membershipRole });
  const owner = m('owner', 'owner');
  const agent = m('agent', 'agent');
  const other = m('other', 'agent');
  const viewer = m('viewer', 'read_only');
  const rival: Actor = { userId: 'rival', agencyId: agencyB, membershipRole: 'owner' };
  const convo = (ownerId: string) => ({ type: 'assistant_conversation', id: 'c-1', agencyId: agencyA, ownerId });

  it('opens for every active member of the agency, read-only too, and nobody else', () => {
    for (const a of [owner, agent, viewer]) expect(can(a, 'assistant:use', { type: 'assistant', agencyId: agencyA })).toBe(true);
    expect(can(rival, 'assistant:use', { type: 'assistant', agencyId: agencyA })).toBe(false);
    expect(can({ userId: 'x' }, 'assistant:use', { type: 'assistant', agencyId: agencyA })).toBe(false);
    expect(can({ userId: 'x', agencyId: agencyA }, 'assistant:use', { type: 'assistant', agencyId: agencyA })).toBe(false);
  });

  it('shows a conversation to its author only — not to an admin, not across agencies', () => {
    expect(can(agent, 'assistant_conversation:read', convo('agent'))).toBe(true);
    expect(can(viewer, 'assistant_conversation:read', convo('viewer'))).toBe(true);
    expect(can(other, 'assistant_conversation:read', convo('agent'))).toBe(false);
    expect(can(owner, 'assistant_conversation:read', convo('agent'))).toBe(false);
    expect(can(rival, 'assistant_conversation:read', { ...convo('rival') })).toBe(false);
    expect(can(agent, 'assistant_conversation:read', { type: 'assistant_conversation', agencyId: agencyA })).toBe(false);
  });
});
