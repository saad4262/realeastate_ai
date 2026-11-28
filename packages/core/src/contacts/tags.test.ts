import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { tidyTag } from './contact-schema';
import { tagContact, untagContact } from './write-contacts';

/** ADR 0107: free tags on a contact — tidy words, each once whatever its case; only whoever may edit the contact. */

const head = vi.hoisted(() => ({ tags: ['Cold'] as string[] }));
vi.mock('./get-contact', async (actual) => ({
  ...(await actual<typeof import('./get-contact')>()),
  loadContactHead: vi.fn(async () => ({
    row: { id: 'c-1', agencyId: 'a-1', name: 'Sara Khan', mergedIntoId: null, tags: head.tags },
    facts: { id: 'c-1', agencyId: 'a-1', assignedTo: 'u-theirs', leadAssigneeIds: [], listingAgentIds: [] },
  })),
}));

const owner: Actor = { userId: 'u-boss', agencyId: 'a-1', membershipRole: 'owner' };
const theirs: Actor = { userId: 'u-theirs', agencyId: 'a-1', membershipRole: 'agent' };
const colleague: Actor = { userId: 'u-other', agencyId: 'a-1', membershipRole: 'agent' };
const readOnly: Actor = { userId: 'u-theirs', agencyId: 'a-1', membershipRole: 'read_only' };

function fakeDb(returned: unknown[] = [{ id: 'c-1' }]) {
  const writes: string[] = [];
  const tx = {
    update: () => ({ set: () => ({ where: () => ({ returning: async () => (writes.push('update'), returned) }) }) }),
    insert: () => ({ values: async () => writes.push('activity') }),
  };
  const transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(tx));
  return { db: { transaction } as unknown as Db, transaction, writes };
}

describe('tidyTag', () => {
  it('tidies spaces, and refuses empty or over 30 characters', () => {
    expect(tidyTag('  Hot   lead ')).toBe('Hot lead');
    expect(tidyTag('   ')).toBeNull();
    expect(tidyTag('x'.repeat(31))).toBeNull();
    expect(tidyTag('x'.repeat(30))).toBe('x'.repeat(30));
  });
});

describe('tagContact / untagContact: who may', () => {
  it('their agent and an owner may; a colleague and a read-only member may not, and nothing is written', async () => {
    head.tags = [];
    for (const a of [theirs, owner]) {
      const { db, writes } = fakeDb();
      expect(await tagContact(db, a, 'c-1', 'VIP')).toBe('added');
      expect(writes).toEqual(['update', 'activity']);
    }
    for (const a of [colleague, readOnly]) {
      const { db, transaction } = fakeDb();
      await expect(tagContact(db, a, 'c-1', 'VIP')).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
      await expect(untagContact(db, a, 'c-1', 'VIP')).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it('the same word in another case is already there; taking it off finds it in any case', async () => {
    head.tags = ['Cold'];
    const a = fakeDb();
    expect(await tagContact(a.db, owner, 'c-1', 'cold')).toBe('already');
    expect(a.transaction).not.toHaveBeenCalled();
    const b = fakeDb();
    expect(await untagContact(b.db, owner, 'c-1', 'COLD')).toBe('removed');
    expect(await untagContact(fakeDb().db, owner, 'c-1', 'Warm')).toBe('none');
  });

  it('at most 20 tags; a word too long is refused', async () => {
    head.tags = Array.from({ length: 20 }, (_, i) => `t${i}`);
    await expect(tagContact(fakeDb().db, owner, 'c-1', 'One more')).rejects.toMatchObject({ code: 'invalid' });
    head.tags = [];
    await expect(tagContact(fakeDb().db, owner, 'c-1', 'x'.repeat(31))).rejects.toMatchObject({ code: 'invalid' });
  });
});
