import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { can } from '../permissions';
import { contactAutoMap, contactMappingProblem, normalizeContactRow, splitAuAddress } from './contact-columns';

/** ADR 0029 amendment, "Contacts import": the columns, and the one place a row becomes a contact. */

describe('contactAutoMap', () => {
  it('matches the usual header names, and leaves the rest unmapped', () => {
    const m = contactAutoMap(['First Name', 'Surname', 'E-mail', 'Mobile', 'Type', 'Agent', 'Notes', 'Favourite colour']);
    expect(m).toMatchObject({ first_name: 0, last_name: 1, email: 2, phone: 3, roles: 4, assigned_email: 5, note: 6, name: null });
  });
});

describe('contactMappingProblem', () => {
  it('needs a column for the name, the email, the phone and the address (ADR 0084)', () => {
    const all = { name: 0, email: 1, phone: 2, address: 3 };
    expect(contactMappingProblem(all)).toBeNull();
    expect(contactMappingProblem({ first_name: 0, email: 1, phone: 2, address: 3 })).toBeNull();
    expect(contactMappingProblem({ ...all, name: null })).toMatch(/name/);
    expect(contactMappingProblem({ ...all, email: null })).toBe('Choose a column for: Email');
    expect(contactMappingProblem({ ...all, phone: null })).toBe('Choose a column for: Phone');
    expect(contactMappingProblem({ ...all, address: null })).toBe('Choose a column for: Street address');
    expect(contactMappingProblem({ name: 0 })).toBe('Choose a column for: Email, Phone, Street address');
  });
});

describe('normalizeContactRow', () => {
  const tz = 'Australia/Sydney';
  const m = { name: 0, first_name: 1, last_name: 2, email: 3, phone: 4, roles: 5, assigned_email: 6, note: 7, next_action: 8, next_action_date: 9, address: 10 };
  const row = (over: Record<number, string>) => Array.from({ length: 11 }, (_, i) => over[i] ?? '');
  /** The four details, so a test can look at everything else. */
  const FOUR = { 3: 'sara@example.com', 4: '0418 920 441', 10: '1 Hill St' };

  it('builds the contact: first + last when there is no full name, email lowercased, roles from words', () => {
    const { row: r, errors } = normalizeContactRow(row({ ...FOUR, 1: 'Sara', 2: ' Khan ', 3: 'Sara@Example.COM', 5: 'Buyers; vendor, investor', 9: '2026-11-14', 8: 'Call back' }), m, tz);
    expect(errors).toEqual([]);
    expect(r).toEqual({
      name: 'Sara Khan',
      email: 'sara@example.com',
      phone: '0418 920 441',
      addressLine: '1 Hill St',
      addressSuburb: null,
      addressState: null,
      addressPostcode: null,
      roles: ['buyer', 'seller', 'investor'],
      assignedEmail: null,
      note: null,
      nextAction: 'Call back',
      nextActionAt: '2026-11-13T22:00:00.000Z',
    });
  });

  it('reads the three newer roles (ADR 0061) as an export writes them', () => {
    const { row: r, errors } = normalizeContactRow(row({ ...FOUR, 0: 'Ali', 5: 'Past clients | Referral; prospect' }), m, tz);
    expect(errors).toEqual([]);
    expect(r?.roles).toEqual(['past_client', 'referral_partner', 'prospect']);
    expect(normalizeContactRow(row({ ...FOUR, 0: 'Ali', 5: 'former client, referral partner' }), m, tz).row?.roles).toEqual(['past_client', 'referral_partner']);
    expect(normalizeContactRow(row({ ...FOUR, 0: 'Ali', 5: 'friend' }), m, tz).errors[0]?.message).toMatch(/past client, referral partner/);
  });

  it('a full name wins over first and last', () => {
    expect(normalizeContactRow(row({ ...FOUR, 0: 'Dr Sara Khan', 1: 'Sara' }), m, tz).row?.name).toBe('Dr Sara Khan');
  });

  it('says every problem at once, against its column', () => {
    const { row: r, errors } = normalizeContactRow(row({ 3: 'not-an-email', 5: 'shopper', 6: 'nobody', 9: '14/11/2026' }), m, tz);
    expect(r).toBeNull();
    const cols = errors.map((e) => e.column);
    expect(cols).toEqual(expect.arrayContaining(['Full name', 'Email', 'Roles (buyer, seller…)', 'Assigned agent’s email', 'Next action date']));
  });

  it('every row needs all four, and says which are missing against their columns (ADR 0084)', () => {
    const { row: r, errors } = normalizeContactRow(row({}), m, tz);
    expect(r).toBeNull();
    expect(errors).toEqual([
      { column: 'Full name', message: 'No name on this row' },
      { column: 'Email', message: 'No email on this row' },
      { column: 'Phone', message: 'No phone on this row' },
      { column: 'Street address', message: 'No address on this row' },
    ]);
    for (const gone of [3, 4, 10] as const) {
      expect(normalizeContactRow(row({ ...FOUR, 0: 'Sara', [gone]: '' }), m, tz).row).toBeNull();
    }
    expect(normalizeContactRow(row({ ...FOUR, 0: 'Sara' }), m, tz).row).not.toBeNull();
  });

  it('everything other than the four is optional', () => {
    const { row: r, errors } = normalizeContactRow(['Sara', 'sara@example.com', '0418 920 441', '1 Hill St'], { name: 0, email: 1, phone: 2, address: 3 }, tz);
    expect(errors).toEqual([]);
    expect(r).toMatchObject({ roles: [], assignedEmail: null, note: null, nextAction: null, nextActionAt: null, addressSuburb: null });
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

describe('the address columns (ADR 0079)', () => {
  const tz = 'Australia/Sydney';

  it('maps the usual header names', () => {
    expect(contactAutoMap(['Name', 'Email', 'Street Address', 'City', 'State', 'Post Code'])).toMatchObject({ address: 2, suburb: 3, state: 4, postcode: 5 });
    expect(contactAutoMap(['Name', 'Email', 'Address', 'Suburb', 'Zip'])).toMatchObject({ address: 2, suburb: 3, postcode: 4 });
  });

  const m = { name: 0, email: 1, address: 2, suburb: 3, state: 4, postcode: 5, phone: 6 };
  const read = (address: string, suburb: string, state: string, postcode: string) => normalizeContactRow(['Sara', 'sara@example.com', address, suburb, state, postcode, '0418 920 441'], m, tz);

  it('keeps the address as written and reads a state name', () => {
    expect(read(' 3/12  Campbell Parade ', 'Bondi Beach', 'New South Wales', '2026').row).toMatchObject({
      addressLine: '3/12 Campbell Parade',
      addressSuburb: 'Bondi Beach',
      addressState: 'NSW',
      addressPostcode: '2026',
    });
    expect(read('1 Hill St', '', 'n.s.w.', '').row?.addressState).toBe('NSW');
  });

  it('puts back the leading zero a spreadsheet drops from a Darwin postcode', () => {
    expect(read('1 Hill St', 'Darwin', 'NT', '800').row?.addressPostcode).toBe('0800');
    expect(read('1 Hill St', '', '', '2026.0').row?.addressPostcode).toBe('2026');
  });

  it('a suburb without a street is not an address', () => {
    expect(read('', 'Manly', 'NSW', '2095').errors).toEqual([{ column: 'Street address', message: 'No address on this row' }]);
  });

  it('one Address column is split when every part can be told apart', () => {
    expect(read('3/12 Campbell Parade, Bondi Beach NSW 2026', '', '', '').row).toMatchObject({ addressLine: '3/12 Campbell Parade', addressSuburb: 'Bondi Beach', addressState: 'NSW', addressPostcode: '2026' });
    expect(splitAuAddress('Unit 3, 12 Campbell Parade, Bondi Beach, New South Wales, 2026, Australia')).toEqual({ line: 'Unit 3, 12 Campbell Parade', suburb: 'Bondi Beach', state: 'NSW', postcode: '2026' });
    expect(splitAuAddress('7 Esplanade, Darwin nt 800')).toEqual({ line: '7 Esplanade', suburb: 'Darwin', state: 'NT', postcode: '0800' });
  });

  it('and kept as written when they cannot', () => {
    for (const raw of ['12 Campbell Parade Bondi Beach NSW 2026', '12 Campbell Parade, Bondi Beach', '12 Campbell Parade, Bondi Beach NSW', '12 Campbell Parade, Bondi Beach Ontario 2026']) {
      expect(splitAuAddress(raw)).toBeNull();
      expect(read(raw, '', '', '').row).toMatchObject({ addressLine: raw, addressSuburb: null, addressState: null, addressPostcode: null });
    }
  });

  it('does not split when the file has the parts in their own columns', () => {
    expect(read('12 Campbell Parade, Bondi Beach NSW 2026', 'Manly', '', '').row).toMatchObject({ addressLine: '12 Campbell Parade, Bondi Beach NSW 2026', addressSuburb: 'Manly' });
  });

  it('a wrong state or postcode is a problem on its own column', () => {
    expect(read('1 Hill St', '', 'Ontario', '').errors).toEqual([{ column: 'State', message: expect.stringMatching(/not an Australian state/) }]);
    expect(read('1 Hill St', '', '', 'SW1A').errors).toEqual([{ column: 'Postcode', message: expect.stringMatching(/four digits/) }]);
  });
});

describe('the template an agency downloads (ADR 0084)', () => {
  const file = readFileSync(resolve(import.meta.dirname, '../../../../apps/console/public/contacts-import-template.csv'), 'utf8');
  const [header, ...rows] = file.trim().split('\n').map((l) => l.split(','));

  it('is the four details and nothing else', () => {
    const m = contactAutoMap(header!);
    expect(contactMappingProblem(m)).toBeNull();
    expect(m).toMatchObject({ name: 0, email: 1, phone: 2, address: 3, suburb: 4, state: 5, postcode: 6 });
    expect(header).toHaveLength(7);
  });

  it('every example row reads as a person with all four', () => {
    const m = contactAutoMap(header!);
    expect(rows.length).toBeGreaterThan(0);
    for (const cells of rows) {
      const { row, errors } = normalizeContactRow(cells, m, 'Australia/Sydney');
      expect(errors).toEqual([]);
      expect(row).toMatchObject({ name: expect.any(String), email: expect.any(String), phone: expect.any(String), addressLine: expect.any(String), addressSuburb: expect.any(String), addressState: expect.any(String), addressPostcode: expect.any(String) });
    }
  });
});
