import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { Db } from '@repo/db';
import { findLocalAgents, nearbySuburbs } from './search-sidebar';

/** Captures every statement and answers with the rows given (pg-proxy wants arrays, in select order). */
function proxy(rows: unknown[][] = []) {
  const seen: string[] = [];
  const db = drizzle(async (text: string, params: unknown[]) => {
    seen.push(`${text} ${JSON.stringify(params)}`);
    return { rows };
  }) as unknown as Db;
  return { db, seen };
}

/** ADR 0099: the public Find agents page. */
describe('findLocalAgents', () => {
  it('asks nothing when there is no suburb and no name', async () => {
    const { db, seen } = proxy();
    expect(await findLocalAgents(db, {})).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  /**
   * Who may be advertised: an active, not-removed member of the listing's
   * agency, an agency that is not suspended, on listings the public could see.
   * Drop any one and a removed agent, or a suspended agency, is promoted on
   * its old sales.
   */
  it('only lists active members of unsuspended agencies, on public listings', async () => {
    const { db, seen } = proxy();
    await findLocalAgents(db, { places: [{ suburb: 'Pakenham', state: 'VIC' }] });
    const sql = seen.join('\n');
    expect(sql).toContain('"membership"."status" = $');
    expect(sql).toContain('"active"');
    expect(sql).toContain('"membership"."removed_at" is null');
    expect(sql).toContain('"agency"."status" <> $');
    expect(sql).toContain('"suspended"');
    expect(sql).toContain(`"listing"."status" in ('live', 'under_offer')`);
    expect(sql).toContain(`interval '12 months'`);
    expect(sql).not.toContain('draft');
    expect(sql).toContain('"pakenham"');
  });

  it('treats a typed % or _ as a character, not a wildcard', async () => {
    const { db, seen } = proxy();
    await findLocalAgents(db, { name: '50%_off' });
    expect(seen.join('\n')).toContain(String.raw`"%50\\%\\_off%"`);
  });

  it('turns the counts the driver hands back as text into numbers', async () => {
    const { db } = proxy([['u-1', 'Sarah Ahmed', 'Alpha Realty', '7', '23', '28']]);
    expect(await findLocalAgents(db, { name: 'sarah' })).toEqual([
      { userId: 'u-1', name: 'Sarah Ahmed', agencyName: 'Alpha Realty', forSale: 7, soldLastYear: 23, medianDaysOnMarket: 28 },
    ]);
  });
});

/** ADR 0099: "Other suburbs" never suggests a suburb already in the search. */
describe('nearbySuburbs exclude', () => {
  it('leaves out every suburb already picked, case-insensitively', async () => {
    const { db, seen } = proxy();
    await nearbySuburbs(db, { exclude: ['Subiaco', 'RYDE'] });
    const sql = seen.join('\n');
    expect(sql).toContain('lower("property"."suburb") not in ($');
    expect(sql).toContain('"subiaco"');
    expect(sql).toContain('"ryde"');
  });

  it('adds nothing when nothing is picked', async () => {
    const { db, seen } = proxy();
    await nearbySuburbs(db, {});
    expect(seen.join('\n')).not.toContain('lower("property"."suburb") not in');
  });
});
