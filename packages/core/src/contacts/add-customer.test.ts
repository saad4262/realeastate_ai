import { describe, expect, it, vi } from 'vitest';
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

/** ADR 0079, ADR 0084: four starting details on Add customer, and the same person always lands on one profile. */

vi.mock('./get-contact', async (actual) => ({
  ...(await actual<typeof import('./get-contact')>()),
  loadContactHead: vi.fn(async () => ({
    facts: { id: 'c-1', agencyId: 'a-1', assignedTo: 'u-theirs', leadAssigneeIds: ['u-lead'], listingAgentIds: [] },
  })),
}));

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

const KEEP = { mayReplace: false };
const REPLACE = { mayReplace: true };

describe('the same person again, for someone who may not edit them: blanks filled, nothing overwritten (planFill)', () => {
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
    const plan = planFill(profile(), incoming({ roles: ['buyer', 'seller'] }), KEEP);
    expect(plan.set).toMatchObject({ phone: '0412 345 678', addressLine: '3/12 Campbell Parade', addressSuburb: 'Bondi Beach', addressPostcode: '2026' });
    expect(plan.filled).toEqual(['phone', 'address', 'roles']);
    expect(plan.addRoles).toEqual(['seller']);
    expect(plan.offered).toEqual([]);
  });

  it('keeps what is already there and offers the other value instead', () => {
    const plan = planFill(
      profile({ phone: '0499 000 111', addressLine: '1 Old St', addressSuburb: 'Manly', addressPostcode: '2095', nextAction: 'Call' }),
      incoming({ name: 'S. Khan', nextAction: 'Email them' }),
      KEEP,
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
    const plan = planFill(profile({ phone: '+61 412 345 678' }), incoming(), KEEP);
    expect(plan.offered.map((o) => o.field)).not.toContain('phone');
  });

  it('replaces only a placeholder name — the email, or "Unknown"', () => {
    expect(planFill(profile({ name: 'sara@example.com' }), incoming(), KEEP).set.name).toBe('Sara Khan');
    expect(planFill(profile({ name: 'Unknown' }), incoming(), KEEP).set.name).toBe('Sara Khan');
    expect(planFill(profile({ name: 'Sara' }), incoming(), KEEP).set.name).toBeUndefined();
  });

  it('records consent only when there is none and they never opted out', () => {
    expect(planFill(profile(), incoming({ marketingConsent: true }), KEEP).recordConsent).toBe(true);
    expect(planFill(profile({ emailOptOutAt: new Date() }), incoming({ marketingConsent: true }), KEEP).recordConsent).toBe(false);
    expect(planFill(profile({ marketingConsentAt: new Date() }), incoming({ marketingConsent: true }), KEEP).recordConsent).toBe(false);
  });
});

describe('the same person again, for someone who may edit them: the new value replaces the old (planFill, ADR 0084)', () => {
  const profile = (over: Partial<FillTarget> = {}): FillTarget => ({
    name: 'Sara',
    email: 'sara@example.com',
    phone: '0499 000 111',
    addressLine: '1 Old St',
    addressSuburb: 'Manly',
    addressState: 'NSW',
    addressPostcode: '2095',
    nextAction: null,
    marketingConsentAt: null,
    emailOptOutAt: null,
    roles: [],
    ...over,
  });
  const incoming = (over: Record<string, unknown> = {}) => createContactSchema.parse({ ...FULL, ...over });

  it('replaces the name, phone and address, and keeps the old ones for the timeline', () => {
    const plan = planFill(profile(), incoming(), REPLACE);
    expect(plan.set).toMatchObject({ name: 'Sara Khan', phone: '0412 345 678', addressLine: '3/12 Campbell Parade', addressSuburb: 'Bondi Beach', addressState: 'NSW', addressPostcode: '2026' });
    expect(plan.replaced).toEqual([
      { field: 'name', from: 'Sara', to: 'Sara Khan' },
      { field: 'phone', from: '0499 000 111', to: '0412 345 678' },
      { field: 'address', from: '1 Old St, Manly NSW 2095', to: '3/12 Campbell Parade, Bondi Beach NSW 2026' },
    ]);
    expect(plan.offered).toEqual([]);
    expect(plan.filled).toEqual([]);
  });

  it('an empty cell erases nothing', () => {
    const plan = planFill(profile(), createContactSchema.parse({ name: 'Sara', email: 'sara@example.com' }), REPLACE);
    expect(plan.set).toEqual({});
    expect(plan.replaced).toEqual([]);
    expect(plan.offered).toEqual([]);
  });

  it('an address that would lose a part stays, and goes on the timeline', () => {
    const plan = planFill(profile(), createContactSchema.parse({ name: 'Sara', email: 'sara@example.com', addressSuburb: 'Bondi' }), REPLACE);
    expect(plan.set).toEqual({});
    expect(plan.replaced).toEqual([]);
    expect(plan.offered).toEqual([{ field: 'address', value: 'Bondi' }]);
  });

  it('the same number or name written differently is not a change', () => {
    const plan = planFill(profile({ name: 'SARA KHAN', phone: '+61 412 345 678' }), incoming(), REPLACE);
    expect(plan.replaced.map((r) => r.field)).toEqual(['address']);
    expect(plan.set.name).toBeUndefined();
    expect(plan.set.phone).toBeUndefined();
  });

  it('the next action and the assignee are still not replaced', () => {
    const plan = planFill(profile({ nextAction: 'Call' }), incoming({ nextAction: 'Email them', assignedTo: '00000000-0000-4000-8000-000000000001' }), REPLACE);
    expect(plan.set.nextAction).toBeUndefined();
    expect(plan.set).not.toHaveProperty('assignedTo');
  });
});

describe('who may replace is who may edit the person (contact:update, ADR 0084)', () => {
  const run = async (actor: Actor) => {
    const writes: { set?: Record<string, unknown>; kinds: string[] } = { kinds: [] };
    const row = { name: 'Sara', email: 'sara@example.com', phone: '0499 000 111', addressLine: '1 Old St', addressSuburb: 'Manly', addressState: 'NSW', addressPostcode: '2095', nextAction: null, marketingConsentAt: null, emailOptOutAt: null, roles: [] };
    const chain = (result: unknown[]) => {
      const c = { from: () => c, where: () => c, for: () => c, limit: async () => result };
      return c;
    };
    const tx = {
      select: () => chain([row]),
      update: () => ({ set: (set: Record<string, unknown>) => { writes.set = set; return { where: async () => undefined }; } }),
      insert: () => ({ values: async (v: { kind?: string }) => { if (v.kind) writes.kinds.push(v.kind); } }),
    };
    const db = { select: () => chain([{ id: 'c-1' }]), transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as Db;
    const saved = await addOrFillContact(db, actor, FULL, { source: 'manual', schema: 'add_customer' });
    return { saved, writes };
  };

  it('an owner replaces', async () => {
    const { saved, writes } = await run({ userId: 'u-own', agencyId: 'a-1', membershipRole: 'owner' });
    expect(saved).toMatchObject({ outcome: 'filled', replaced: ['name', 'phone', 'address'], offered: [], visible: true });
    expect(writes.set).toMatchObject({ phone: '0412 345 678', addressSuburb: 'Bondi Beach' });
    expect(writes.kinds).toEqual(['details_replaced']);
  });

  it('the agent they are assigned to replaces', async () => {
    const { saved } = await run({ userId: 'u-theirs', agencyId: 'a-1', membershipRole: 'agent' });
    expect(saved).toMatchObject({ replaced: ['name', 'phone', 'address'], offered: [], visible: true });
  });

  it('another agent changes nothing already there, and is not told who it is', async () => {
    const { saved, writes } = await run({ userId: 'u-other', agencyId: 'a-1', membershipRole: 'agent' });
    expect(saved).toMatchObject({ replaced: [], offered: ['name', 'phone', 'address'], visible: false });
    expect(writes.set).toBeUndefined();
    expect(writes.kinds).toEqual(['details_offered']);
  });

  it('an agent who only sees them through a lead may not replace either', async () => {
    const { saved, writes } = await run({ userId: 'u-lead', agencyId: 'a-1', membershipRole: 'agent' });
    expect(saved).toMatchObject({ replaced: [], offered: ['name', 'phone', 'address'], visible: true });
    expect(writes.set).toBeUndefined();
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
