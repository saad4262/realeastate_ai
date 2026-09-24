import { describe, expect, it } from 'vitest';
import { can, type Actor } from '../permissions';
import { registerAgencySchema, slugifyAgency } from './register-schema';

const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';

/** The actor registerAgency() produces: owner of exactly the agency it created. */
const newOwner: Actor = {
  userId: 'owner-a',
  agencyId: agencyA,
  membershipRole: 'owner',
};

describe('agency registration contract', () => {
  it('parses a minimal payload and defaults the first office', () => {
    const input = registerAgencySchema.parse({
      agencyName: 'Bondi Prestige Group',
      ownerName: 'Jane Doe',
    });
    expect(input.officeName).toBe('Head Office');
    expect(input.abn).toBeNull();
    expect(input.phone).toBeNull();
  });

  it('treats blank optional fields as null, not empty strings', () => {
    const input = registerAgencySchema.parse({
      agencyName: 'Coastal Realty',
      ownerName: 'Sam Lee',
      abn: '',
      phone: '',
      officeAddress: '',
    });
    expect(input.abn).toBeNull();
    expect(input.phone).toBeNull();
    expect(input.officeAddress).toBeNull();
  });

  it('rejects a malformed ABN and a too-short agency name', () => {
    expect(() =>
      registerAgencySchema.parse({
        agencyName: 'Coastal Realty',
        ownerName: 'Sam Lee',
        abn: '123',
      }),
    ).toThrow();
    expect(() =>
      registerAgencySchema.parse({ agencyName: 'X', ownerName: 'Sam Lee' }),
    ).toThrow();
  });

  it('slugifies agency names into url-safe slugs', () => {
    expect(slugifyAgency('Bondi Prestige Group')).toBe('bondi-prestige-group');
    expect(slugifyAgency('  O’Brien & Co.  ')).toBe('o-brien-co');
    expect(slugifyAgency('!!!')).toBe('agency');
  });
});

describe('registration authz', () => {
  it('gives the registering owner the agency console and team management', () => {
    expect(can(newOwner, 'console:agency', { type: 'console', agencyId: agencyA })).toBe(true);
    expect(can(newOwner, 'team:manage', { type: 'team', agencyId: agencyA })).toBe(true);
    expect(can(newOwner, 'agency:billing', { type: 'agency', agencyId: agencyA })).toBe(true);
  });

  it('does not leak that owner into any other agency', () => {
    expect(can(newOwner, 'team:manage', { type: 'team', agencyId: agencyB })).toBe(false);
    expect(can(newOwner, 'agency:billing', { type: 'agency', agencyId: agencyB })).toBe(false);
    expect(can(newOwner, 'listing:edit', { type: 'listing', agencyId: agencyB, id: 'l1' })).toBe(
      false,
    );
  });

  it('denies every console surface to an account with no membership yet', () => {
    const pending: Actor = { userId: 'signed-up-no-agency' };
    expect(can(pending, 'console:agency', { type: 'console' })).toBe(false);
    expect(can(pending, 'console:agent', { type: 'console' })).toBe(false);
    expect(can(pending, 'team:manage', { type: 'team', agencyId: agencyA })).toBe(false);
  });
});
