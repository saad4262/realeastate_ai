import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { memberContext } from './member-actor';

/** A Drizzle-shaped fake: every builder call chains, and awaiting the chain is one statement. */
function fakeDb(rows: unknown[]) {
  let statements = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    statements += 1;
    return Promise.resolve(rows).then(resolve, reject);
  };
  return { db: chain as unknown as Db, count: () => statements };
}

const active = {
  agencyId: 'ag-1', role: 'agent', status: 'active', removedAt: null, agencyStatus: 'active',
  agencyName: 'Acme', agencySlug: 'acme', sendsPausedAt: null, sendsPausedReason: null, userName: 'Sam', links: ['l-1', 'l-2'],
};

describe('memberContext (V1-PERFORMANCE-PLAN steps 3–4)', () => {
  it('is one statement, with the listing links on the actor', async () => {
    const { db, count } = fakeDb([active]);
    const ctx = await memberContext(db, 'u-1');
    expect(count()).toBe(1);
    expect(ctx.actor).toEqual({ userId: 'u-1', agencyId: 'ag-1', membershipRole: 'agent', listingAgentOf: ['l-1', 'l-2'] });
    expect(ctx).toMatchObject({ blocked: null, agencyName: 'Acme', agencySlug: 'acme', userName: 'Sam', sendsPaused: null });
  });

  it('carries the sends pause', async () => {
    const { db } = fakeDb([{ ...active, sendsPausedAt: new Date(), sendsPausedReason: 'spike' }]);
    expect((await memberContext(db, 'u-1')).sendsPaused).toEqual({ reason: 'spike' });
  });

  it('no agency on the actor for a suspended agency, a blocked member, a removed member or no membership', async () => {
    const cases: [unknown[], string | null][] = [
      [[{ ...active, agencyStatus: 'suspended' }], 'agency_suspended'],
      [[{ ...active, status: 'suspended' }], 'member_blocked'],
      [[{ ...active, status: 'suspended', removedAt: new Date() }], null],
      [[], null],
    ];
    for (const [rows, blocked] of cases) {
      const ctx = await memberContext(fakeDb(rows).db, 'u-1');
      expect(ctx.actor).toEqual({ userId: 'u-1' });
      expect(ctx.blocked).toBe(blocked);
      expect(ctx.agencyName).toBeNull();
    }
  });
});

/**
 * Step 4: the console's actor (gate, pages, actions, polls) never pays for the header's counts. A scan, because the
 * console app has no test runner: the counts load only in the chrome, and the actor's query counts nothing.
 */
describe('the header counts stay in the chrome', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const CONSOLE = join(ROOT, 'apps', 'console');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      if (n === 'node_modules' || n.startsWith('.next')) return [];
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
    });

  it('only loadConsoleChrome loads them', () => {
    const callers = [...walk(join(CONSOLE, 'app')), ...walk(join(CONSOLE, 'lib')), ...walk(join(CONSOLE, 'components'))]
      .filter((f) => /\bloadHeaderCounts\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(callers).toEqual(['apps/console/lib/require-console-access.ts']);
  });

  it('the actor is memberContext, with no count of its own', () => {
    const src = readFileSync(join(CONSOLE, 'lib', 'load-actor.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function queryActorContext'), src.indexOf('export const loadActorContext'));
    expect(body).toContain('memberContext(');
    expect(body).not.toMatch(/count\(/i);
  });
});
