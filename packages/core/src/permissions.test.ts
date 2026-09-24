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
});
