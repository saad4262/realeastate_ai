import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { visibleContactIdsSql } from './visibility';

/**
 * A deleted contact (ADR 0025 amendment, 2026-10-09: 7 days to restore) is
 * gone from everything that asks "which contacts may this person see" — the
 * directory, search, threads, the assistant, bulk email — for owners and
 * agents alike. Restoring is the only way back during those 7 days.
 */
const dialect = new PgDialect();
const agencyId = '11111111-1111-1111-1111-111111111111';

describe('visibleContactIdsSql leaves deleted contacts out', () => {
  for (const membershipRole of ['owner', 'admin', 'agent', 'read_only'] as const) {
    it(membershipRole, () => {
      const q = dialect.sqlToQuery(visibleContactIdsSql({ userId: 'u1', agencyId, membershipRole })).sql;
      expect(q).toMatch(/c\.deleted_at is null/);
    });
  }
});
