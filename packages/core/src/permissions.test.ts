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
