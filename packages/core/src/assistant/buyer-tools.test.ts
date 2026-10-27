import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@repo/db';
import { briefFitsSql, describeTarget, type BuyerTarget } from './buyer-tools';
import { findBuyersInput } from './schema';
import { runAssistantTool, type ToolContext } from './tools';

const target = (t: Partial<BuyerTarget>): BuyerTarget => ({ channel: 'sale', suburb: null, low: null, high: null, bedrooms: null, bathrooms: null, propertyType: null, ...t });
const render = (t: BuyerTarget) => new PgDialect().sqlToQuery(sql.join(briefFitsSql(t), sql` and `));

describe('find_buyers input (ADR 0059)', () => {
  it('takes the brief’s own example in words', () => {
    const v = findBuyersInput.parse({ suburb: 'Pakenham', bedrooms: 3, property_type: 'house', price_to: 800000 });
    expect(v).toMatchObject({ suburb: 'Pakenham', bedrooms: 3, property_type: 'house', price_to: 800000, limit: 20 });
  });
  it('refuses a listing and words together, nothing at all, and a reversed range', () => {
    expect(findBuyersInput.safeParse({ listing: 'P1', suburb: 'Pakenham' }).success).toBe(false);
    expect(findBuyersInput.safeParse({}).success).toBe(false);
    expect(findBuyersInput.safeParse({ channel: 'rent' }).success).toBe(false);
    expect(findBuyersInput.safeParse({ price_from: 900000, price_to: 800000 }).success).toBe(false);
    expect(findBuyersInput.safeParse({ listing: 'C1' }).success).toBe(false);
  });
});

describe('what was searched for, in words', () => {
  it('reads like the Requirements tab', () => {
    expect(describeTarget(target({ suburb: 'Pakenham', high: 800000, bedrooms: 3, propertyType: 'house' }))).toBe('Buying · up to $800,000 · 3 bed · House · Pakenham');
    expect(describeTarget(target({ channel: 'rent', low: 500, high: 650 }))).toBe('Renting · $500/wk – $650/wk · any suburb');
    expect(describeTarget(target({ low: 750000, high: 750000 }))).toBe('Buying · $750,000 · any suburb');
  });
  it('says so when a listing has no price, instead of hiding it', () => {
    expect(describeTarget(target({ address: '12 King St, Pakenham', suburb: 'Pakenham', priceUnknown: true, bedrooms: 3 }))).toBe(
      'Buying · 12 King St, Pakenham · price not stated, so budgets were not checked · 3 bed',
    );
  });
});

describe('the rule, from the property’s side', () => {
  it('bounds only what the property gives', () => {
    const q = render(target({}));
    expect(q.sql).toBe(`br.status = 'active' and br.channel::text = $1`);
    expect(q.params).toEqual(['sale']);
  });
  it('“under $800k, 3 bed house in Pakenham”: overlap on the open end, at least their beds, suburb and type or any', () => {
    const q = render(target({ suburb: 'Pakenham', high: 800000, bedrooms: 3, propertyType: 'house' }));
    expect(q.sql).toContain('(br.price_min is null or br.price_min <= $2)');
    expect(q.sql).not.toContain('br.price_max');
    expect(q.sql).toContain('(br.min_bedrooms is null or br.min_bedrooms <= $3)');
    expect(q.sql).toContain('cardinality(br.suburbs) = 0 or exists');
    expect(q.sql).toContain('cardinality(br.property_types) = 0 or lower($5) = any (br.property_types)');
    expect(q.params).toEqual(['sale', 800000, 3, 'Pakenham', 'house']);
  });
  it('“from $700k” bounds only the brief’s maximum', () => {
    const q = render(target({ low: 700000 }));
    expect(q.sql).toContain('(br.price_max is null or br.price_max >= $2)');
    expect(q.sql).not.toContain('br.price_min');
  });
});

describe('find_buyers as a tool', () => {
  const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
  const ctx: ToolContext = { db: noDb, actor: { userId: 'u1', agencyId: '11111111-1111-1111-1111-111111111111', membershipRole: 'agent' }, skillsOff: async () => new Set(), timeZone: 'Australia/Sydney', handles: {}, now: new Date() };
  it('refuses a listing reference this conversation was never given, before the database', async () => {
    const out = await runAssistantTool(ctx, 'find_buyers', { listing: 'P7' });
    expect(out.isError).toBe(true);
  });
});
