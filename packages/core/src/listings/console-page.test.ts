import { describe, expect, it } from 'vitest';
import { consolePage } from './console-page';

describe('the console listings page', () => {
  it('reads a 1-based page number and refuses anything else', () => {
    expect(consolePage(undefined)).toBe(1);
    expect(consolePage('1')).toBe(1);
    expect(consolePage('7')).toBe(7);
    // A page number is the only thing that can widen the query, so everything
    // that is not one falls back to the first page rather than to NaN — which
    // reaches the database as `offset NaN`.
    for (const bad of ['0', '-3', '2.5', 'abc', '', 'Infinity', '1e9999']) {
      expect(consolePage(bad)).toBe(1);
    }
  });

  it('takes the first value when a query string repeats the key', () => {
    expect(consolePage(['3', '9'])).toBe(3);
  });
});
