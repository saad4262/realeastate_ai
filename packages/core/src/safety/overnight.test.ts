import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { overnightFailures, overnightLines } from './overnight';

/** PLATFORM-PLAN 3.7: last night's failures, for owners and admins, on the agency's own clock. */
const A = '11111111-1111-1111-1111-111111111111';
const who = (membershipRole: Actor['membershipRole']): Actor => ({ userId: '33333333-3333-3333-3333-333333333333', agencyId: A, membershipRole });
const dialect = new PgDialect();

function fakeDb(row: Record<string, unknown> | null) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
      seen.push(dialect.sqlToQuery(q));
      return row ? [row] : [];
    },
  } as unknown as Db;
  return { db, seen };
}

describe('overnightFailures', () => {
  it('owners and admins: one statement, the agency’s 6 pm yesterday on its own clock, the counts in words', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { db, seen } = fakeDb({ since: '2026-11-20T07:00:00Z', time_zone: 'Australia/Sydney', texts: 3, emails: 0, bulk_emails: 1, automations: 0, skills: 0, workflows: 2 });
      const out = await overnightFailures(db, who(role), new Date('2026-11-20T21:00:00Z'));
      expect(seen).toHaveLength(1);
      expect(seen[0]!.sql).toContain("- interval '6 hours') at time zone time_zone as since");
      expect(seen[0]!.params).toContain(A);
      expect(out?.since.toISOString()).toBe('2026-11-20T07:00:00.000Z');
      expect(out?.lines.map((l) => l.words)).toEqual(['3 texts were not sent', '1 bulk email recipient was not reached', '2 workflow events gave up after their retries']);
    }
  });

  it('a text held by a pause is not a failure', async () => {
    const { db, seen } = fakeDb({ since: '2026-11-20T07:00:00Z', time_zone: 'Australia/Sydney' });
    await overnightFailures(db, who('owner'));
    expect(seen[0]!.sql).toContain('s.error is distinct from $');
  });

  it('agents and assistants get nothing, and no query runs', async () => {
    for (const role of ['agent', 'assistant', 'read_only'] as const) {
      const { db, seen } = fakeDb({});
      expect(await overnightFailures(db, who(role))).toBeNull();
      expect(seen).toEqual([]);
    }
  });

  it('nothing failed: no lines', () => {
    expect(overnightLines({ texts: 0, emails: '0' })).toEqual([]);
    expect(overnightLines({ emails: 1 }).map((l) => [l.words, l.href])).toEqual([['1 email was not sent', '/inbox']]);
  });
});
