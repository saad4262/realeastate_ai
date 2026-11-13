import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { aiBudgetAllows, capUsd, checkAiBudget, platformCapUsd } from './index';

const NOW = new Date('2026-11-13T00:00:00Z');
const env = (over: Record<string, string> = {}) => ({ AI_DAILY_BUDGET_USD: '20', ...over }) as unknown as NodeJS.ProcessEnv;

/** One `execute`, answering the spend row; keeps every statement rendered so a test can read it. */
function spendDb(row: { total?: string; person?: string; agency?: string }) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (q: SQL) => {
      const r = new PgDialect().sqlToQuery(q);
      statements.push({ sql: r.sql, params: r.params });
      return [{ total: '0', person: '0', agency: '0', ...row }];
    },
  } as unknown as Db;
  return { db, statements };
}

describe('capUsd: one reading of a cap, for every feature', () => {
  it('reads a number', () => {
    expect(capUsd('20', 5)).toBe(20);
    expect(capUsd(' 2.5 ', 5)).toBe(2.5);
    expect(capUsd('0', 5)).toBe(0);
  });

  it('falls back for unset, blank, negative or not a number — never NaN, never a silent 0', () => {
    // '20$' used to become NaN, and `spent >= NaN` is false: a typo in Vercel switched the budget OFF.
    // '' used to become 0 in some copies, which switched every AI feature off instead.
    for (const raw of [undefined, '', '   ', '20$', 'twenty', '-1', 'NaN', 'Infinity']) expect(capUsd(raw, 5), String(raw)).toBe(5);
  });

  it('the platform cap is AI_DAILY_BUDGET_USD, $5 when unset', () => {
    expect(platformCapUsd(env())).toBe(20);
    expect(platformCapUsd({} as NodeJS.ProcessEnv)).toBe(5);
    expect(platformCapUsd(env({ AI_DAILY_BUDGET_USD: '20 USD' }))).toBe(5);
  });
});

describe('checkAiBudget', () => {
  it('allows under the platform cap and refuses at it', async () => {
    expect((await checkAiBudget(spendDb({ total: '19.99' }).db, { now: NOW, env: env() })).allowed).toBe(true);
    const at = await checkAiBudget(spendDb({ total: '20' }).db, { now: NOW, env: env() });
    expect(at).toMatchObject({ allowed: false, reason: 'global_cap' });
    expect(at.global).toMatchObject({ spentUsd: 20, capUsd: 20, remainingUsd: 0, exceeded: true });
  });

  it('still refuses when the cap in env is mistyped', async () => {
    const r = await checkAiBudget(spendDb({ total: '1000' }).db, { now: NOW, env: env({ AI_DAILY_BUDGET_USD: '20$' }) });
    expect(r).toMatchObject({ allowed: false, reason: 'global_cap' });
  });

  it('asks ONE statement over the last 24 hours of ai_run', async () => {
    const { db, statements } = spendDb({});
    await checkAiBudget(db, { now: NOW, env: env(), userId: 'u1', agency: { id: 'a1', features: ['inbox:draft'], capUsd: 2 } });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toMatch(/from ai_run/);
    expect(statements[0]!.params).toContain('2026-11-12T00:00:00.000Z');
  });

  it('an agency window: only that agency and those features, refused at its own cap', async () => {
    const { db, statements } = spendDb({ total: '3', agency: '2' });
    const r = await checkAiBudget(db, { now: NOW, env: env(), agency: { id: 'a1', features: ['inbox:summary', 'inbox:draft'], capUsd: 2 } });
    expect(r).toMatchObject({ allowed: false, reason: 'agency_cap' });
    expect(r.agency).toMatchObject({ spentUsd: 2, capUsd: 2 });
    expect(statements[0]!.params).toEqual(expect.arrayContaining(['a1', 'inbox:summary', 'inbox:draft']));
  });

  it('the skills’ per-person window: AI_DAILY_BUDGET_USD_PER_USER, everything but the assistant', async () => {
    const { db, statements } = spendDb({ total: '1', person: '0.25' });
    const r = await checkAiBudget(db, { now: NOW, env: env(), userId: 'u1' });
    expect(r).toMatchObject({ allowed: false, reason: 'user_cap' });
    expect(r.user).toMatchObject({ spentUsd: 0.25, capUsd: 0.25 });
    expect(statements[0]!.sql).toMatch(/not in/);
    expect(statements[0]!.params).toEqual(expect.arrayContaining(['u1', 'assistant']));
  });

  it('a person window over named features (the assistant’s own)', async () => {
    const { statements, db } = spendDb({ person: '0.5' });
    const r = await checkAiBudget(db, { now: NOW, env: env(), user: { id: 'u1', features: ['assistant'], capUsd: 1 } });
    expect(r).toMatchObject({ allowed: true, reason: null });
    expect(r.user).toMatchObject({ spentUsd: 0.5, capUsd: 1 });
    expect(statements[0]!.sql).not.toMatch(/not in/);
  });

  it('the platform cap is named first when more than one is spent', async () => {
    const r = await checkAiBudget(spendDb({ total: '25', agency: '9' }).db, { now: NOW, env: env(), agency: { id: 'a1', features: ['x'], capUsd: 2 } });
    expect(r.reason).toBe('global_cap');
  });

  it('reads numeric strings as numbers (postgres.js returns numeric as text)', async () => {
    const r = await checkAiBudget(spendDb({ total: '0.004688' }).db, { now: NOW, env: env() });
    expect(typeof r.global.spentUsd).toBe('number');
    expect(r.global.remainingUsd).toBeCloseTo(19.995312);
  });
});

describe('aiBudgetAllows: the public site’s question', () => {
  it('yes under the platform cap, no at it', async () => {
    expect(await aiBudgetAllows(spendDb({ total: '19' }).db, { now: NOW, env: env() })).toBe(true);
    expect(await aiBudgetAllows(spendDb({ total: '20' }).db, { now: NOW, env: env() })).toBe(false);
  });

  it('no when the spend cannot be read: a model is never called on a guess', async () => {
    const broken = { execute: async () => { throw new Error('connection refused'); } } as unknown as Db;
    expect(await aiBudgetAllows(broken, { now: NOW, env: env() })).toBe(false);
  });
});

/**
 * The guard that keeps it central. Every cost ceiling used to be its own copy of the cap and its own
 * query, and the copy that was never written is how four public AI routes ended up with no budget.
 */
describe('one budget', () => {
  const repo = resolve(__dirname, '../../../..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (name === 'node_modules' || name === '.next' || name.startsWith('.next')) return [];
      if (statSync(p).isDirectory()) return files(p);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });

  it('only packages/core/src/ai-budget reads AI_DAILY_BUDGET_USD', () => {
    const readers = ['packages/core/src', 'packages/ai/src', 'apps/web', 'apps/console']
      .flatMap((d) => files(join(repo, d)))
      .filter((f) => /AI_DAILY_BUDGET_USD\b/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
      .map((f) => relative(repo, f));
    expect(readers).toEqual(['packages/core/src/ai-budget/index.ts']);
  });

  /** Every public route that can reach a model. Each must ask the budget (aiBudgetAllows) before it does. */
  const PUBLIC_AI_ROUTES = [
    'apps/web/app/api/chat/route.ts',
    'apps/web/app/api/research/route.ts',
    'apps/web/app/api/renovation/route.ts',
    'apps/web/app/api/renovation/rooms/route.ts',
    'apps/web/app/api/due-diligence/route.ts',
    'apps/web/app/api/inspections/summary/route.ts',
    'apps/web/app/api/agent-message/draft/route.ts',
  ];

  it.each(PUBLIC_AI_ROUTES)('%s asks the AI budget', (file) => {
    expect(readFileSync(join(repo, file), 'utf8')).toMatch(/await aiBudgetAllows\(/);
  });

  it('the list above is every web route that imports a model pipeline', () => {
    const routes = files(join(repo, 'apps/web/app/api')).filter((f) => f.endsWith('route.ts'));
    const reachModel = routes
      .filter((f) => /from '@repo\/ai\//.test(readFileSync(f, 'utf8')) && !f.includes('/cron/'))
      .map((f) => relative(repo, f))
      .sort();
    expect(reachModel).toEqual([...PUBLIC_AI_ROUTES].sort());
  });
});
