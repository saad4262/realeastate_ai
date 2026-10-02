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

    it('answers the same as publish today, for every role', () => {
      const roles = ['owner', 'admin', 'agent', 'assistant', 'property_manager', 'read_only'] as const;
      for (const membershipRole of roles) {
        for (const listingAgentOf of [[], [listingA]]) {
          const actor: Actor = { userId: 'u', agencyId: agencyA, membershipRole, listingAgentOf };
          expect(can(actor, 'listing:sell', sellable)).toBe(
            can(actor, 'listing:publish', sellable),
          );
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
