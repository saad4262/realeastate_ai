import { describe, expect, it } from 'vitest';
import { getDb, getHealthDb } from './client';

/**
 * V1-PERFORMANCE-PLAN step 1: /api/health has its own pool. Sharing the app's, it waited behind every page and
 * failed 96–99% in the 2026-11-21 load run, which a monitor reads as "the site is down". Nothing connects here:
 * postgres.js opens a connection on the first query.
 */
const URL_A = 'postgres://u:p@127.0.0.1:1/a';
const max = (db: ReturnType<typeof getDb>) => (db.$client as unknown as { options: { max: number } }).options.max;

describe('getHealthDb', () => {
  it('is a separate pool of one connection, kept per connection string', () => {
    const health = getHealthDb(URL_A);
    // Booleans, not the objects: a failing toBe would try to print a whole pool.
    expect(health === getDb(URL_A), 'health shares the app pool').toBe(false);
    expect(getHealthDb(URL_A) === health, 'health pool not memoised').toBe(true);
    expect(max(health)).toBe(1);
    expect(max(getDb(URL_A))).toBe(5);
  });
});
