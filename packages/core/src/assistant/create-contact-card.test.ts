import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import { addOrFillContact } from '../contacts/write-contacts';
import { addFromCard } from './actions';
import { proposeCreateContact } from './crm-tools';
import { createContactInput } from './schema';
import type { ToolContext } from './tools';

/** ADR 0084: the assistant's card asks for the same four details as the form, and takes the same path. */

vi.mock('../contacts/write-contacts', async (actual) => ({
  ...(await actual<typeof import('../contacts/write-contacts')>()),
  addOrFillContact: vi.fn(async () => ({ id: 'c-1', outcome: 'created' })),
}));

const FULL = { name: 'Sara Khan', email: 'sara@example.com', phone: '0412 345 678', address_line: '3/12 Campbell Parade', suburb: 'Bondi Beach', state: 'NSW', postcode: '2026' };

describe('the tool asks for all four', () => {
  it('takes them, and roles are optional', () => {
    expect(createContactInput.parse(FULL).roles).toEqual([]);
  });

  it.each(['name', 'email', 'phone', 'address_line', 'suburb', 'state', 'postcode'])('refuses without %s', (field) => {
    const { [field as keyof typeof FULL]: _gone, ...rest } = FULL;
    expect(createContactInput.safeParse(rest).success).toBe(false);
  });

  it('refuses a postcode or state that is not Australian', () => {
    expect(createContactInput.safeParse({ ...FULL, postcode: 'SW1A' }).success).toBe(false);
    expect(createContactInput.safeParse({ ...FULL, state: 'Ontario' }).success).toBe(false);
  });
});

describe('the card', () => {
  const propose = async (held: unknown[], role: 'agent' | 'read_only' = 'agent') => {
    const collect = vi.fn();
    const chain = { from: () => chain, where: () => chain, limit: async () => held };
    const ctx = { db: { select: () => chain } as unknown as Db, actor: { userId: 'u', agencyId: 'a', membershipRole: role }, plan: { collect }, handles: {}, timeZone: 'Australia/Sydney', now: new Date() } as unknown as ToolContext;
    const outcome = await proposeCreateContact(ctx, createContactInput.parse(FULL), 'label');
    return { outcome, step: collect.mock.calls[0]?.[0] };
  };

  it('a new person: the address is on the card and in what is frozen', async () => {
    const { step } = await propose([]);
    expect(step.card.title).toBe('Add Sara Khan to your contacts');
    expect(step.card.lines).toContainEqual({ label: 'Address', value: '3/12 Campbell Parade, Bondi Beach NSW 2026' });
    expect(step.card.lines).toContainEqual({ label: 'Assigned to', value: 'You' });
    expect(step.args).toMatchObject({ tool: 'create_contact', address: { line: '3/12 Campbell Parade', suburb: 'Bondi Beach', state: 'NSW', postcode: '2026' } });
  });

  it('an email already held: still a card, saying it updates, showing only what was given', async () => {
    const { step } = await propose([{ id: 'existing-id' }]);
    expect(step.card.title).toBe("Update Sara Khan's profile");
    expect(step.card.notes.join(' ')).toMatch(/already a customer/);
    expect(step.card.lines.map((l: { label: string }) => l.label)).not.toContain('Assigned to');
    expect(JSON.stringify(step)).not.toContain('existing-id');
  });

  it('a read-only member gets no card', async () => {
    const { outcome, step } = await propose([], 'read_only');
    expect(step).toBeUndefined();
    expect(JSON.stringify(outcome.result)).toMatch(/may not add contacts/);
  });
});

describe('approved', () => {
  const tx = {} as Db;
  const actor = { userId: 'u', agencyId: 'a', membershipRole: 'agent' as const };

  it('runs the form’s path with the address', async () => {
    const out = await addFromCard(tx, actor, { tool: 'create_contact', name: 'Sara', email: 'sara@example.com', phone: '0412 345 678', address: { line: '1 Hill St', suburb: 'Manly', state: 'NSW', postcode: '2095' }, roles: ['buyer'] });
    expect(addOrFillContact).toHaveBeenLastCalledWith(
      tx,
      actor,
      { name: 'Sara', email: 'sara@example.com', phone: '0412 345 678', addressLine: '1 Hill St', addressSuburb: 'Manly', addressState: 'NSW', addressPostcode: '2095', roles: ['buyer'] },
      { source: 'manual', schema: 'contact' },
    );
    expect(out).toEqual({ contactId: 'c-1', outcome: 'created' });
  });

  it('a card frozen before ADR 0084 still runs', async () => {
    await addFromCard(tx, actor, { tool: 'create_contact', name: 'Old', email: null, phone: '0412 345 678', roles: [] });
    expect(addOrFillContact).toHaveBeenLastCalledWith(tx, actor, { name: 'Old', phone: '0412 345 678', roles: [] }, { source: 'manual', schema: 'contact' });
  });
});
