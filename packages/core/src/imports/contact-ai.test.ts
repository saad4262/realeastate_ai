import { describe, expect, it } from 'vitest';
import { acceptFix, applyFix, maskSample, mergeSuggestedMapping, rowToClean, shouldAskMapper } from './contact-ai';
import { contactAutoMap, type ContactImportMapping } from './contact-columns';

/** ADR 0056: what the contacts import does around a model — never the model itself. No network. */

const TZ = 'Australia/Sydney';

describe('step 1 — the mapping a model may fill', () => {
  it('masks every letter and digit: the shape of a value is sent, never the person', () => {
    expect(maskSample('Jane Smith')).toBe('Xxxx Xxxxx');
    expect(maskSample('0412 345 678')).toBe('9999 999 999');
    expect(maskSample('jane.smith@gmail.com')).toBe('xxxx.xxxxx@xxxxx.xxx');
    expect(maskSample('14/11/2026')).toBe('99/99/9999');
    expect(maskSample('Zoë Ñúñez')).toBe('Xxx Xxxxx');
  });

  it('asks only when a headed column went unused and a field is unmatched', () => {
    const headers = ['Full Name', 'Email', 'Client Address Details', 'Mob'];
    expect(shouldAskMapper(contactAutoMap(headers), headers)).toBe(true);
    const all = ['name', 'first_name', 'last_name', 'email', 'phone', 'roles', 'assigned_email', 'note', 'next_action', 'next_action_date'];
    expect(shouldAskMapper(contactAutoMap(all), all)).toBe(false);
    // Every column already used: nothing for a model to place.
    expect(shouldAskMapper(contactAutoMap(['Name', 'Email']), ['Name', 'Email'])).toBe(false);
  });

  it('keeps every synonym match and fills only empty fields, from unused columns', () => {
    const headers = ['Full Name', 'Email', 'Mob', 'Client Type'];
    const auto = contactAutoMap(headers); // name 0, email 1
    const { mapping, aiFields } = mergeSuggestedMapping(auto, { name: 3, phone: 2, roles: 3, email: 2 }, headers.length);
    expect(mapping.name).toBe(0); // the synonym's match stands
    expect(mapping.email).toBe(1);
    expect(mapping.phone).toBe(2);
    expect(mapping.roles).toBe(3);
    expect(aiFields).toEqual(['phone', 'roles']);
  });

  it('drops a suggestion out of range, not a whole number, or a column already taken', () => {
    const auto = contactAutoMap(['Name', 'Email', 'X']);
    const { mapping, aiFields } = mergeSuggestedMapping(auto, { phone: 9, roles: 1.5, note: 0, next_action: 2, assigned_email: 2 }, 3);
    expect(mapping.phone).toBeNull();
    expect(mapping.roles).toBeNull();
    expect(mapping.note).toBeNull(); // column 0 is the name
    // Fields claim in their own order: assigned_email takes column 2, so next_action may not reuse it.
    expect(aiFields).toEqual(['assigned_email']);
    expect(mapping.next_action).toBeNull();
  });
});

describe('step 2 — a fix must come from the row (the guards)', () => {
  const src = 'SMITH, Jane | jane.smith @ gmail,com | +61 (0)412-345-678 | Purchaser | 14 Nov 26';

  it('email: only what is written, tidied — never a domain made up', () => {
    expect(acceptFix('email', 'jane.smith@gmail.com', src, 'jane.smith @ gmail,com')).toBe(true);
    expect(acceptFix('email', 'jane.smith@gmail.com.au', src, '')).toBe(false);
    expect(acceptFix('email', 'jane@example.com', src, '')).toBe(false);
  });

  it('phone: the last eight digits must be in the row', () => {
    expect(acceptFix('phone', '0412 345 678', src, '+61 (0)412-345-678')).toBe(true);
    expect(acceptFix('phone', '0499 999 999', src, '')).toBe(false);
    expect(acceptFix('phone', '1234', src, '')).toBe(false);
  });

  it('names: every word must be in the row', () => {
    expect(acceptFix('name', 'Jane Smith', src, 'SMITH, Jane')).toBe(true);
    expect(acceptFix('first_name', 'Jane', src, '')).toBe(true);
    expect(acceptFix('name', 'Janet Smith', src, '')).toBe(false);
  });

  it('roles: from the list, and only for a cell that said something', () => {
    expect(acceptFix('roles', 'buyer', src, 'Purchaser')).toBe(true);
    expect(acceptFix('roles', 'buyer', src, '')).toBe(false);
    expect(acceptFix('roles', 'vip', src, 'VIP')).toBe(false);
  });

  it('dates: day, month and year all in the cell, written YYYY-MM-DD', () => {
    expect(acceptFix('next_action_date', '2026-11-14', src, '14 Nov 26')).toBe(true);
    expect(acceptFix('next_action_date', '2026-11-14', src, '14/11/2026')).toBe(true);
    expect(acceptFix('next_action_date', '2026-12-14', src, '14/11/2026')).toBe(false);
    expect(acceptFix('next_action_date', '14/11/2026', src, '14/11/2026')).toBe(false);
  });
});

describe('step 2 — what is sent and what a fix becomes', () => {
  const headers = ['Name', 'Email', 'Phone', 'Notes', 'Unmapped secret'];
  const mapping: ContactImportMapping = { ...contactAutoMap(headers) };
  const cells = ['SMITH, Jane', 'jane.smith @ gmail,com', '', 'Met at open home', 'tax file 123'];

  it('sends the mapped cleanable fields only — never a note or a column nobody mapped', () => {
    const ask = rowToClean(7, cells, mapping, [{ column: 'Email', message: 'bad' }]);
    expect(ask).toEqual({ rowNumber: 7, values: { name: 'SMITH, Jane', email: 'jane.smith @ gmail,com' }, problems: ['Email: bad'] });
    expect(JSON.stringify(ask)).not.toContain('open home');
    expect(JSON.stringify(ask)).not.toContain('tax file');
  });

  it('a guarded fix is re-checked by the normal rules and says what it changed', () => {
    const out = applyFix(cells, mapping, { rowNumber: 7, values: { email: 'jane.smith@gmail.com', name: 'Jane Smith' } }, TZ);
    expect(out.row).toMatchObject({ name: 'Jane Smith', email: 'jane.smith@gmail.com', note: 'Met at open home' });
    expect(out.changes.map((c) => c.message)).toEqual([
      'Fixed by AI: “SMITH, Jane” → “Jane Smith” — check it',
      'Fixed by AI: “jane.smith @ gmail,com” → “jane.smith@gmail.com” — check it',
    ]);
  });

  it('an invented value is ignored, and a row that still fails stays failed', () => {
    const out = applyFix(cells, mapping, { rowNumber: 7, values: { email: 'someone@else.com' } }, TZ);
    expect(out.row).toBeNull();
    expect(out.changes).toEqual([]);
  });
});
