import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@repo/db';
import { adFacts, factSql } from './facts';
import { runDealSync } from '../deals/sync';

/** ADR 0075: one address, several agencies — each ad's own facts, and a deal per agency. */

const dialect = new PgDialect();
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('a listing’s facts: its own ad first, the address only for a blank', () => {
  it('every fact reads coalesce(listing, property), the listing first', () => {
    for (const [k, v] of Object.entries(adFacts)) {
      const q = dialect.sqlToQuery(v);
      expect(q.sql, k).toMatch(/^coalesce\("listing"\."[a-z_]+", "property"\."[a-z_]+"\)$/);
    }
  });
  it('raw SQL gets the same, under the caller’s aliases, and refuses anything but an alias', () => {
    expect(dialect.sqlToQuery(factSql('bedrooms', 'li', 'p')).sql).toBe('coalesce(li.bedrooms, p.bedrooms)');
    expect(() => factSql('bedrooms', 'li; drop table x', 'p')).toThrow();
  });
});

/**
 * The guard: core reads no physical fact straight off the shared `property` row, except where the row is
 * written (property-resolver), the one place the rule lives (facts.ts) and the address's own fallback
 * inside a coalesce. A new read that forgets the listing goes red here.
 */
describe('no read of a property fact that skips the listing', () => {
  const FACT = /\bproperty\.(bedrooms|bathrooms|carSpaces|propertyType|landAreaSqm|buildingAreaSqm|yearBuilt)\b/;
  // In SQL text: `p.bedrooms`. Not a JavaScript object that happens to be called p (`p.bedrooms !== …`, `${p.bedrooms}`).
  const RAW = /(?<!\$\{)\b(p|pr)\.(bedrooms|bathrooms|car_spaces|property_type|land_area_sqm|building_area_sqm|year_built)\b(?!\s*(!==|===|\?\?))/;
  const ALLOWED = new Set(['listings/property-resolver.ts', 'listings/facts.ts']);
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  }
  it('finds none', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // The address's own value as a coalesce's fallback is the rule, not a breach of it.
        const stripped = line.replace(/coalesce\([^()]*\)/g, '').replace(/lastAd(Text|Number)\([^()]*\)/g, '');
        if (FACT.test(stripped) || RAW.test(stripped)) bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe('the deal sync opens a deal per agency', () => {
  it('every insert into deal names (agency_id, property_id) as its conflict, never the address alone', async () => {
    const seen: string[] = [];
    const db = { execute: (q: Parameters<typeof dialect.sqlToQuery>[0]) => { seen.push(dialect.sqlToQuery(q).sql); return Promise.resolve([]); } } as unknown as Db;
    await runDealSync(db);
    const inserts = seen.filter((s) => /insert into deal \(/.test(s));
    expect(inserts).toHaveLength(2);
    for (const s of inserts) {
      expect(s).toMatch(/on conflict \(agency_id, property_id\) where status = 'open' do nothing/);
      expect(s).not.toMatch(/on conflict \(property_id\)/);
    }
    expect(seen.join('\n')).toMatch(/distinct on \(li\.agency_id, li\.property_id\)/);
    expect(seen.join('\n')).toMatch(/d\.agency_id = x\.agency_id and d\.property_id = x\.property_id/);
  });
});
