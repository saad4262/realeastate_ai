import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { ContactError, listContacts } from './list-contacts';

const agencyA = '11111111-1111-1111-1111-111111111111';
const owner: Actor = { userId: 'u-owner', agencyId: agencyA, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: agencyA, membershipRole: 'agent' };
const viewer: Actor = { userId: 'u-view', agencyId: agencyA, membershipRole: 'read_only' };

/**
 * Records the WHERE it was handed. It cannot tell whether the clause is
 * CORRECT — Postgres answers that and the smoke parity check asks it — but it
 * proves an agent's directory is narrowed and an admin's is not, from can().
 */
function fakeDb(rows: unknown[] = []) {
  const wheres: { sql: string; params: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'offset']) {
    chain[m] = () => chain;
  }
  const dialect = new PgDialect();
  chain.where = (clause: SQL) => {
    const q = dialect.sqlToQuery(clause);
    wheres.push({ sql: q.sql, params: q.params });
    return chain;
  };
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return { db: chain as unknown as Db, wheres };
}

describe('the contact directory', () => {
  it('refuses an actor with no agency before touching the database', async () => {
    const { db, wheres } = fakeDb();
    await expect(listContacts(db, { userId: 'x' })).rejects.toBeInstanceOf(ContactError);
    expect(wheres).toHaveLength(0);
  });

  it("narrows an agent's directory to their own people, and not an admin's", async () => {
    const forAgent = fakeDb();
    await listContacts(forAgent.db, agent);
    const agentWhere = forAgent.wheres[0]!;
    expect(agentWhere.sql).toContain('c.assigned_to = ');
    expect(agentWhere.sql).toContain("l.kind <> 'offer'");
    expect(agentWhere.params).toContain('u-agent');

    const forOwner = fakeDb();
    await listContacts(forOwner.db, owner);
    expect(forOwner.wheres[0]!.sql).not.toContain('c.assigned_to = ');
  });

  it('lets a read-only member look but not add', async () => {
    const { db } = fakeDb();
    const page = await listContacts(db, viewer);
    expect(page.mayCreate).toBe(false);
    expect(page.seesAll).toBe(false);
  });

  it("ignores another member's book as a filter for a non-admin", async () => {
    const { db, wheres } = fakeDb();
    await listContacts(db, agent, { assigned: '22222222-2222-2222-2222-222222222222' });
    expect(wheres[0]!.params).not.toContain('22222222-2222-2222-2222-222222222222');
  });

  it('treats LIKE wildcards in a search as plain characters', async () => {
    const { db, wheres } = fakeDb();
    await listContacts(db, owner, { q: '50%_off' });
    expect(wheres[0]!.params).toContain('%50\\%\\_off%');
  });

  it('reports an empty directory as zero, not undefined', async () => {
    const { db } = fakeDb([]);
    expect((await listContacts(db, owner)).total).toBe(0);
  });
});
