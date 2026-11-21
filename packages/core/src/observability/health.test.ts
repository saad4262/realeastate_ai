import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { BUILD_MIGRATIONS, healthReport, pingHeartbeat } from './health';

const db = (row: Record<string, unknown> | Error) =>
  ({ execute: async () => { if (row instanceof Error) throw row; return [row]; } }) as unknown as Db;
const expected = { count: 99, lastWhen: 1_794_652_156_071 };

describe('healthReport', () => {
  it('ok when the database has every migration the build expects (or more)', async () => {
    expect(await healthReport(db({ n: 99, last: '1794652156071' }), expected)).toEqual({ status: 'ok', checks: { database: 'ok', schema: 'ok' } });
    expect((await healthReport(db({ n: 100, last: '1794700000000' }), expected)).status).toBe('ok');
  });

  it('degraded, schema behind, when a migration of this build is missing', async () => {
    expect(await healthReport(db({ n: 98, last: '1794000000000' }), expected)).toEqual({ status: 'degraded', checks: { database: 'ok', schema: 'behind' } });
  });

  it('degraded, database down, when the query fails — and no error text leaks', async () => {
    const r = await healthReport(db(new Error('password authentication failed for user postgres.xyz')), expected);
    expect(r).toEqual({ status: 'degraded', checks: { database: 'down', schema: 'unknown' } });
    expect(JSON.stringify(r)).not.toMatch(/password|postgres/);
  });

  it('answers down within its timeout when the database never answers (a monitor must not hang)', async () => {
    const silent = { execute: () => new Promise(() => undefined) } as unknown as Db;
    const started = Date.now();
    expect(await healthReport(silent, expected, 50)).toEqual({ status: 'degraded', checks: { database: 'down', schema: 'unknown' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reads the build’s migrations from drizzle’s journal', () => {
    expect(BUILD_MIGRATIONS.count).toBeGreaterThan(90);
    expect(BUILD_MIGRATIONS.lastWhen).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('pingHeartbeat', () => {
  it('pings the URL, or its /fail, and swallows errors; nothing without a URL', async () => {
    const calls: string[] = [];
    const f = (async (u: string) => { calls.push(u); throw new Error('down'); }) as unknown as typeof fetch;
    await pingHeartbeat('https://hc-ping.com/abc', 'ok', f);
    await pingHeartbeat('https://hc-ping.com/abc/', 'fail', f);
    await pingHeartbeat(undefined, 'ok', f);
    expect(calls).toEqual(['https://hc-ping.com/abc', 'https://hc-ping.com/abc/fail']);
  });
});

/**
 * V1-PERFORMANCE-PLAN step 1: every health route reads through its app's health pool (getWebHealthDb,
 * getConsoleHealthDb), never the shared one: behind a busy pool the check failed 96–99% in the 2026-11-21 load run.
 */
describe('health routes', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const routes = ['web', 'console'].flatMap((app) => walk(join(ROOT, 'apps', app, 'app', 'api', 'health'))).filter((f) => f.endsWith('route.ts'));

  it('use the health pool, not the app pool', () => {
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const f of routes) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/\bget(Web|Console)HealthDb\(/);
      expect(src, f).not.toMatch(/\bget(Web|Console)Db\(/);
    }
  });
});
