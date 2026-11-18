import { describe, expect, it } from 'vitest';
import { poolOptions } from './pool-options';

/**
 * PLATFORM-PLAN 1.8: the connections each server instance holds come from env, not a constant. With Fluid
 * compute one instance serves many requests, and a page runs several queries at once: 2 would queue them,
 * 10 multiplies across instances toward the pooler's client limit (Medium 600). The load test sets the value.
 */
describe('poolOptions', () => {
  it('defaults: 5 connections, idle ones closed after 20 s, a 10 s connect timeout, recycled every 30 min', () => {
    expect(poolOptions({})).toEqual({ prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10, max_lifetime: 1800 });
  });

  it('reads DB_POOL_MAX', () => {
    expect(poolOptions({ DB_POOL_MAX: '8' }).max).toBe(8);
    expect(poolOptions({ DB_POOL_MAX: ' 3 ' }).max).toBe(3);
  });

  it('ignores a value that is not a whole number from 1 to 50: a typo never means 0 or unbounded', () => {
    for (const raw of ['', '0', '-2', '2.5', 'ten', '500', 'NaN']) expect(poolOptions({ DB_POOL_MAX: raw }).max, raw).toBe(5);
  });

  it('keeps prepare off: the transaction pooler cannot hold prepared statements', () => {
    expect(poolOptions({ DB_POOL_MAX: '9' }).prepare).toBe(false);
  });
});
