import { describe, expect, it } from 'vitest';
import { can } from '../permissions';
import { contactAutoMap, contactMappingProblem, normalizeContactRow } from './contact-columns';

/** ADR 0029 amendment, "Contacts import": the columns, and the one place a row becomes a contact. */

describe('contactAutoMap', () => {
  it('matches the usual header names, and leaves the rest unmapped', () => {
    const m = contactAutoMap(['First Name', 'Surname', 'E-mail', 'Mobile', 'Type', 'Agent', 'Notes', 'Favourite colour']);
    expect(m).toMatchObject({ first_name: 0, last_name: 1, email: 2, phone: 3, roles: 4, assigned_email: 5, note: 6, name: null });
  });
});

describe('contactMappingProblem', () => {
  it('needs a name column and an email or phone column', () => {
    expect(contactMappingProblem({ email: 0 })).toMatch(/name/);
    expect(contactMappingProblem({ name: 0 })).toMatch(/Email or Phone/);
    expect(contactMappingProblem({ first_name: 0, phone: 1 })).toBeNull();
  });
});

describe('normalizeContactRow', () => {
  const tz = 'Australia/Sydney';
  const m = { name: 0, first_name: 1, last_name: 2, email: 3, phone: 4, roles: 5, assigned_email: 6, note: 7, next_action: 8, next_action_date: 9 };
  const row = (over: Record<number, string>) => Array.from({ length: 10 }, (_, i) => over[i] ?? '');

  it('builds the contact: first + last when there is no full name, email lowercased, roles from words', () => {
    const { row: r, errors } = normalizeContactRow(row({ 1: 'Sara', 2: ' Khan ', 3: 'Sara@Example.COM', 5: 'Buyers; vendor, investor', 9: '2026-11-14', 8: 'Call back' }), m, tz);
    expect(errors).toEqual([]);
    expect(r).toEqual({
      name: 'Sara Khan',
      email: 'sara@example.com',
      phone: null,
      roles: ['buyer', 'seller', 'investor'],
      assignedEmail: null,
      note: null,
      nextAction: 'Call back',
      nextActionAt: '2026-11-13T22:00:00.000Z',
    });
  });

  it('a full name wins over first and last', () => {
    expect(normalizeContactRow(row({ 0: 'Dr Sara Khan', 1: 'Sara', 4: '0418 920 441' }), m, tz).row?.name).toBe('Dr Sara Khan');
  });

  it('says every problem at once, against its column', () => {
    const { row: r, errors } = normalizeContactRow(row({ 3: 'not-an-email', 5: 'shopper', 6: 'nobody', 9: '14/11/2026' }), m, tz);
    expect(r).toBeNull();
    const cols = errors.map((e) => e.column);
    expect(cols).toEqual(expect.arrayContaining(['Full name', 'Email', 'Roles (buyer, seller…)', 'Assigned agent’s email', 'Next action date']));
  });

  it('needs an email or a phone on the row', () => {
    expect(normalizeContactRow(row({ 0: 'Sara' }), m, tz).errors[0]?.message).toMatch(/No email and no phone/);
  });

  it('has no marketing-consent column at all — an imported list is never consent', () => {
    expect(Object.keys(contactAutoMap(['Name', 'Email', 'Marketing consent', 'Opt in']))).not.toContain('marketing_consent');
  });
});

describe('who may import contacts (contact_import:create)', () => {
  const r = { type: 'contact', agencyId: 'a' };
  it('whoever may add contacts — never a read-only member or another agency', () => {
    expect(can({ userId: 'u', agencyId: 'a', membershipRole: 'agent' }, 'contact_import:create', r)).toBe(true);
    expect(can({ userId: 'u', agencyId: 'a', membershipRole: 'owner' }, 'contact_import:create', r)).toBe(true);
    expect(can({ userId: 'u', agencyId: 'a', membershipRole: 'read_only' }, 'contact_import:create', r)).toBe(false);
    expect(can({ userId: 'u', agencyId: 'b', membershipRole: 'owner' }, 'contact_import:create', r)).toBe(false);
  });
});
