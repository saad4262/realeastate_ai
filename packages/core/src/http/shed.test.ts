import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concurrencyGate, lowPriorityLimit, withLowPriority } from './shed';

/** ADR 0098: polls and beacons give way to people when the pool is busy. */
describe('concurrencyGate', () => {
  it('lets in up to its limit, refuses the next, and frees a slot on release (once)', () => {
    const gate = concurrencyGate(2);
    const a = gate.enter();
    const b = gate.enter();
    expect(a && b).toBeTruthy();
    expect(gate.enter()).toBeNull();
    a!();
    a!(); // a second release must not open two slots
    expect(gate.inFlight).toBe(1);
    expect(gate.enter()).not.toBeNull();
    expect(gate.enter()).toBeNull();
  });
});

describe('lowPriorityLimit', () => {
  it('is 40% of DB_POOL_MAX, at least 1', () => {
    expect(lowPriorityLimit({})).toBe(2);
    expect(lowPriorityLimit({ DB_POOL_MAX: '10' })).toBe(4);
    expect(lowPriorityLimit({ DB_POOL_MAX: '1' })).toBe(1);
    expect(lowPriorityLimit({ DB_POOL_MAX: 'nonsense' })).toBe(2);
  });
});

describe('withLowPriority', () => {
  it('answers 503 with Retry-After at once, without running the handler, when the gate is full', async () => {
    const gate = concurrencyGate(1);
    gate.enter();
    let ran = false;
    const res = await withLowPriority(async () => {
      ran = true;
      return new Response('ok');
    }, gate);
    expect(ran).toBe(false);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
  });

  it('runs the handler when there is room, and frees the slot even when it throws', async () => {
    const gate = concurrencyGate(1);
    expect((await withLowPriority(async () => new Response('ok'), gate)).status).toBe(200);
    await expect(withLowPriority(async () => { throw new Error('boom'); }, gate)).rejects.toThrow('boom');
    expect(gate.inFlight).toBe(0);
  });
});

/** The three low-priority routes shed; a page, layout or action never does. */
describe('which routes shed', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      if (n === 'node_modules' || n.startsWith('.next')) return [];
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const files = ['web', 'console'].flatMap((app) => walk(join(ROOT, 'apps', app, 'app'))).filter((f) => /\.(ts|tsx)$/.test(f));
  const LOW = ['apps/console/app/api/live/route.ts', 'apps/console/app/api/notifications/route.ts', 'apps/web/app/api/activity/route.ts'];

  it('the polls and the beacon run through withLowPriority', () => {
    for (const f of LOW) expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/return withLowPriority\(/);
  });

  it('nothing else does', () => {
    const others = files.filter((f) => !LOW.includes(relative(ROOT, f)) && readFileSync(f, 'utf8').includes('withLowPriority'));
    expect(others.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
