import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES_FROM, concurrentIndexes, migrationProblems } from './migration-rules';

const dir = resolve(__dirname, '../drizzle');
const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= RULES_FROM);

describe('migration rules (PLATFORM-PLAN 1.13)', () => {
  it.each(files)('%s follows them', (f) => {
    expect(migrationProblems(readFileSync(resolve(dir, f), 'utf8'))).toEqual([]);
  });

  it('the rules start at a migration that exists', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('refuses a migration without the lock timeout, with CONCURRENTLY, or with an index that is not IF NOT EXISTS', () => {
    expect(migrationProblems('ALTER TABLE "a" ADD COLUMN "b" text;')).toHaveLength(1);
    expect(migrationProblems(`SET LOCAL lock_timeout = '1s';--> statement-breakpoint\nCREATE INDEX CONCURRENTLY "x" ON "a" ("b");`)).toHaveLength(1);
    expect(migrationProblems(`SET LOCAL lock_timeout = '1s';--> statement-breakpoint\nCREATE INDEX "x" ON "a" ("b");`)).toHaveLength(1);
    expect(migrationProblems(`-- why\nSET LOCAL lock_timeout = '1s';--> statement-breakpoint\nCREATE UNIQUE INDEX IF NOT EXISTS "x" ON "a" ("b");`)).toEqual([]);
  });

  it('rewrites a migration\'s indexes to build concurrently, and nothing else', () => {
    const sql = `SET LOCAL lock_timeout = '1s';--> statement-breakpoint
ALTER TABLE "a" ALTER COLUMN "id" SET DEFAULT uuid_v7();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a_b_idx" ON "a" USING btree ("b");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a_c_idx" ON "a" ("c");`;
    expect(concurrentIndexes(sql)).toEqual([
      { name: 'a_b_idx', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "a_b_idx" ON "a" USING btree ("b")' },
      { name: 'a_c_idx', sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "a_c_idx" ON "a" ("c")' },
    ]);
    expect(() => concurrentIndexes('CREATE INDEX "x" ON "a" ("b");')).toThrow(/IF NOT EXISTS/);
  });
});
