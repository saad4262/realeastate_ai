import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import {
  addCustomerSchema,
  createContactSchema,
  formatContactAddress,
  missingDetails,
  updateContactSchema,
} from './contact-schema';
import { addOrFillContact, planFill, type FillTarget } from './write-contacts';

/** ADR 0079: four starting details on Add customer, and the same person always lands on one profile. */

const FULL = {
  name: 'Sara Khan',
  email: 'Sara@Example.com',
  phone: '0412 345 678',
  addressLine: '3/12 Campbell Parade',
  addressSuburb: 'Bondi Beach',
  addressState: 'nsw',
  addressPostcode: '2026',
};

describe('Add customer asks for name, email, phone and address', () => {
  it('takes all four', () => {
    const parsed = addCustomerSchema.parse(FULL);
    expect(parsed).toMatchObject({ email: 'sara@example.com', addressState: 'NSW', addressPostcode: '2026' });
  });

  it.each([
    ['email', 'Give their email'],
    ['phone', 'Give their phone number'],
    ['addressLine', 'Give their street address'],
    ['addressSuburb', 'Give their suburb'],
    ['addressPostcode', 'Give their postcode'],
  ])('refuses without %s', (field, message) => {
    const r = addCustomerSchema.safeParse({ ...FULL, [field]: '  ' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(message);
  });

  it('a postcode is four digits and a state is an Australian one', () => {
    expect(addCustomerSchema.safeParse({ ...FULL, addressPostcode: '226' }).success).toBe(false);
    expect(addCustomerSchema.safeParse({ ...FULL, addressState: 'XX' }).success).toBe(false);
  });

  it('an import row, the assistant and Edit still need none of the address', () => {
    expect(createContactSchema.safeParse({ name: 'Tom', email: 'tom@example.com' }).success).toBe(true);
    expect(updateContactSchema.safeParse({ name: 'Tom' }).success).toBe(true);
  });
});

describe('the address on a profile', () => {
  const none = { addressLine: null, addressSuburb: null, addressState: null, addressPostcode: null };

  it('reads as one line', () => {
    expect(formatContactAddress({ addressLine: '3/12 Campbell Parade', addressSuburb: 'Bondi Beach', addressState: 'NSW', addressPostcode: '2026' }))
      .toBe('3/12 Campbell Parade, Bondi Beach NSW 2026');
    expect(formatContactAddress({ ...none, addressSuburb: 'Parramatta' })).toBe('Parramatta');
    expect(formatContactAddress(none)).toBeNull();
  });

  it('says which starting details are missing; a suburb alone counts as an address', () => {
    expect(missingDetails({ ...none, email: 'a@b.co', phone: null })).toEqual(['phone', 'address']);
    expect(missingDetails({ ...none, addressSuburb: 'Parramatta', email: null, phone: '0412' })).toEqual(['email']);
  });
});

describe('the same person again fills blanks and never overwrites (planFill)', () => {
  const profile = (over: Partial<FillTarget> = {}): FillTarget => ({
    name: 'Sara Khan',
    email: 'sara@example.com',
    phone: null,
    addressLine: null,
    addressSuburb: null,
    addressState: null,
    addressPostcode: null,
    nextAction: null,
    marketingConsentAt: null,
    emailOptOutAt: null,
    roles: ['buyer'],
    ...over,
  });
  const incoming = (over: Record<string, unknown> = {}) => createContactSchema.parse({ ...FULL, ...over });

  it('fills a blank phone and address, adds a new role, and offers nothing', () => {
    const plan = planFill(profile(), incoming({ roles: ['buyer', 'seller'] }));
    expect(plan.set).toMatchObject({ phone: '0412 345 678', addressLine: '3/12 Campbell Parade', addressSuburb: 'Bondi Beach', addressPostcode: '2026' });
    expect(plan.filled).toEqual(['phone', 'address', 'roles']);
    expect(plan.addRoles).toEqual(['seller']);
    expect(plan.offered).toEqual([]);
  });

  it('keeps what is already there and offers the other value instead', () => {
    const plan = planFill(
      profile({ phone: '0499 000 111', addressLine: '1 Old St', addressSuburb: 'Manly', addressPostcode: '2095', nextAction: 'Call' }),
      incoming({ name: 'S. Khan', nextAction: 'Email them' }),
    );
    expect(plan.set).toEqual({});
    expect(plan.filled).toEqual([]);
    expect(plan.offered).toEqual([
      { field: 'name', value: 'S. Khan' },
      { field: 'phone', value: '0412 345 678' },
      { field: 'address', value: '3/12 Campbell Parade, Bondi Beach NSW 2026' },
    ]);
  });

  it('one number written two ways is the same number', () => {
    const plan = planFill(profile({ phone: '+61 412 345 678' }), incoming());
    expect(plan.offered.map((o) => o.field)).not.toContain('phone');
  });

  it('replaces only a placeholder name — the email, or "Unknown"', () => {
    expect(planFill(profile({ name: 'sara@example.com' }), incoming()).set.name).toBe('Sara Khan');
    expect(planFill(profile({ name: 'Unknown' }), incoming()).set.name).toBe('Sara Khan');
    expect(planFill(profile({ name: 'Sara' }), incoming()).set.name).toBeUndefined();
  });

  it('records consent only when there is none and they never opted out', () => {
    expect(planFill(profile(), incoming({ marketingConsent: true })).recordConsent).toBe(true);
    expect(planFill(profile({ emailOptOutAt: new Date() }), incoming({ marketingConsent: true })).recordConsent).toBe(false);
    expect(planFill(profile({ marketingConsentAt: new Date() }), incoming({ marketingConsent: true })).recordConsent).toBe(false);
  });
});

describe('who may add (contact:create, asked before anything is read)', () => {
  const untouched = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as Db;
  it('a read-only member may not, and the database is never reached', async () => {
    const viewer: Actor = { userId: 'u-view', agencyId: 'a-1', membershipRole: 'read_only' };
    await expect(addOrFillContact(untouched, viewer, FULL, { source: 'manual', schema: 'add_customer' })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('nor someone in no agency', async () => {
    const outsider: Actor = { userId: 'u-x' };
    await expect(addOrFillContact(untouched, outsider, FULL, { source: 'import', schema: 'contact' })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('an agent with three of the four is refused before the database too', async () => {
    const agent: Actor = { userId: 'u-a', agencyId: 'a-1', membershipRole: 'agent' };
    await expect(addOrFillContact(untouched, agent, { ...FULL, phone: '' }, { source: 'manual', schema: 'add_customer' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
