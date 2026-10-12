import { describe, expect, it } from 'vitest';
import { and, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Actor } from '../permissions';
import { leadAgentIdSql, listingScopeFilters } from './scope';
import { contactScopeFilters } from '../contacts/visibility';

/**
 * The scope helpers figures are built on (ADR 0036 P1, P2): the agency first,
 * always; the narrowing for anyone without the `*_read_all` action; nothing at
 * all for someone with no agency.
 */

const dialect = new PgDialect();
const render = (filters: ReturnType<typeof listingScopeFilters>) => dialect.sqlToQuery(and(...filters)!);
const agencyId = '11111111-1111-1111-1111-111111111111';
const NONE = '00000000-0000-0000-0000-000000000000';
const owner: Actor = { userId: 'u-owner', agencyId, membershipRole: 'owner' };
const admin: Actor = { userId: 'u-admin', agencyId, membershipRole: 'admin' };
const agent: Actor = { userId: 'u-agent', agencyId, membershipRole: 'agent' };
const viewer: Actor = { userId: 'u-viewer', agencyId, membershipRole: 'read_only' };
const stranger: Actor = { userId: 'u-x' };

describe('listingScopeFilters (ADR 0036 P1)', () => {
  it('owners and admins: the agency, nothing narrower', () => {
    for (const a of [owner, admin]) {
      const q = render(listingScopeFilters(a));
      expect(q.sql).toBe('"listing"."agency_id" = $1');
      expect(q.params).toEqual([agencyId]);
    }
  });

  it('agents and viewers: the agency AND only listings they are named on', () => {
    for (const a of [agent, viewer]) {
      const q = render(listingScopeFilters(a));
      expect(q.sql).toMatch(/^\("listing"\."agency_id" = \$1 and "listing"\."id" in \(select "listing_agent"\."listing_id" from "listing_agent" where "listing_agent"\."user_id" = \$2\)\)$/);
      expect(q.params).toEqual([agencyId, a.userId]);
    }
  });

  it('no agency: the zero UUID, so nothing', () => {
    const q = render(listingScopeFilters(stranger));
    expect(q.params[0]).toBe(NONE);
    expect(q.params).toContain('u-x');
  });

  it('the lead agent is the lowest display order, oldest first — one person or none (P4)', () => {
    const q = dialect.sqlToQuery(leadAgentIdSql(sql`listing.id`));
    expect(q.sql).toMatch(/order by la\.display_order, la\.created_at, la\.user_id limit 1/);
    expect(q.sql).not.toMatch(/display_order = 0/);
  });
});

describe('contactScopeFilters (ADR 0036 P2)', () => {
  it('owners and admins: the agency and live (not merged) contacts', () => {
    for (const a of [owner, admin]) {
      const q = render(contactScopeFilters(a));
      expect(q.sql).toBe('("contact"."agency_id" = $1 and "contact"."merged_into_id" is null)');
      expect(q.params).toEqual([agencyId]);
    }
  });

  it('agents and viewers: also only the contacts the directory shows them', () => {
    for (const a of [agent, viewer]) {
      const q = render(contactScopeFilters(a));
      expect(q.sql.startsWith('("contact"."agency_id" = $1 and "contact"."merged_into_id" is null and "contact"."id" in (select c.id from contact c')).toBe(true);
      expect(q.params[0]).toBe(agencyId);
      expect(q.params).toContain(a.userId);
      // Offers never make a contact visible.
      expect(q.sql).toContain("l.kind <> 'offer'");
    }
  });

  it('no agency: the zero UUID, so nothing', () => {
    expect(render(contactScopeFilters(stranger)).params[0]).toBe(NONE);
  });
});
