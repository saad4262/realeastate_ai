import { describe, expect, it } from 'vitest';
import { can, mfaMark, MFA_ACTIONS, refusedForMfa, type Actor } from './permissions';

/** PLATFORM-PLAN 1.3: an owner, admin or platform admin without a second factor cannot reach billing or the team. */
const A = '11111111-1111-1111-1111-111111111111';
const owner: Actor = { userId: 'u', agencyId: A, membershipRole: 'owner' };
const agency = { type: 'agency' as const, agencyId: A };

describe('MFA in can()', () => {
  it('an owner marked aal1 is refused billing and team actions; aal2 is allowed', () => {
    expect(can({ ...owner, aal: 'aal1' }, 'billing:manage', agency)).toBe(false);
    expect(can({ ...owner, aal: 'aal1' }, 'team:manage', agency)).toBe(false);
    expect(can({ ...owner, aal: 'aal2' }, 'billing:manage', agency)).toBe(true);
    expect(can({ ...owner, aal: 'aal2' }, 'team:manage', agency)).toBe(true);
  });
  it('everything else is unchanged for an aal1 owner (MFA guards only its own actions)', () => {
    expect(can({ ...owner, aal: 'aal1' }, 'listing:create', { type: 'listing', agencyId: A })).toBe(true);
    expect(MFA_ACTIONS.has('listing:create')).toBe(false);
  });
});

describe('refusedForMfa: the refusal is only the missing second factor', () => {
  it('an aal1 owner on team or billing: yes (verify, then come back)', () => {
    expect(refusedForMfa({ ...owner, aal: 'aal1' }, 'team:manage', agency)).toBe(true);
    expect(refusedForMfa({ ...owner, aal: 'aal1' }, 'agency:billing', agency)).toBe(true);
  });
  it('no: allowed already, an action MFA does not guard, or refused anyway (an agent, another agency)', () => {
    expect(refusedForMfa({ ...owner, aal: 'aal2' }, 'team:manage', agency)).toBe(false);
    expect(refusedForMfa(owner, 'team:manage', agency)).toBe(false);
    expect(refusedForMfa({ ...owner, aal: 'aal1' }, 'listing:create', { type: 'listing', agencyId: A })).toBe(false);
    expect(refusedForMfa({ userId: 'u', agencyId: A, membershipRole: 'agent', aal: 'aal1' }, 'team:manage', agency)).toBe(false);
    expect(refusedForMfa({ ...owner, aal: 'aal1' }, 'team:manage', { type: 'agency', agencyId: '22222222-2222-2222-2222-222222222222' })).toBe(false);
  });
});

describe('mfaMark (decision D-6, MFA_ENFORCED; step-up 1.22)', () => {
  const on = { MFA_ENFORCED: '1' };
  const NOW = 1_800_000_000_000;
  const fresh = { aal: 'aal2' as const, mfaAt: NOW / 1000 - 60 };
  it('off until enforced: nobody is marked', () => {
    expect(mfaMark({ membershipRole: 'owner' }, { aal: 'aal1' }, {}, NOW)).toEqual({});
  });
  it('owners, admins and platform admins are marked with their session level', () => {
    expect(mfaMark({ membershipRole: 'owner' }, { aal: 'aal1' }, on, NOW)).toEqual({ aal: 'aal1' });
    expect(mfaMark({ membershipRole: 'admin' }, undefined, on, NOW)).toEqual({ aal: 'aal1' });
    expect(mfaMark({ platformAdmin: true }, fresh, on, NOW)).toEqual({ aal: 'aal2' });
  });
  it('a second factor older than the step-up window counts as none: billing and team ask again', () => {
    expect(mfaMark({ membershipRole: 'owner' }, { aal: 'aal2', mfaAt: NOW / 1000 - 31 * 60 }, on, NOW)).toEqual({ aal: 'aal1' });
    expect(mfaMark({ membershipRole: 'owner' }, { aal: 'aal2', mfaAt: NOW / 1000 - 29 * 60 }, on, NOW)).toEqual({ aal: 'aal2' });
    expect(mfaMark({ membershipRole: 'owner' }, { aal: 'aal2', mfaAt: NOW / 1000 - 9 * 60 }, { ...on, MFA_STEP_UP_MINUTES: '5' }, NOW)).toEqual({ aal: 'aal1' });
    expect(mfaMark({ membershipRole: 'owner' }, { aal: 'aal2' }, on, NOW)).toEqual({ aal: 'aal1' });
  });
  it('agents and viewers are not (yet): D-6 brings agents in three months later', () => {
    expect(mfaMark({ membershipRole: 'agent' }, { aal: 'aal1' }, on, NOW)).toEqual({});
  });
});
