import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { concurrentIndexes } from './migration-rules';
import { assertNotProduction } from './production-guard';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * PLATFORM-PLAN 1.13: build a migration's indexes CONCURRENTLY, one at a time, before running the migration, when a
 * table is big enough that a plain CREATE INDEX would hold up writes. The migration keeps its CREATE INDEX IF NOT
 * EXISTS, which then finds each index built.
 *
 *   pnpm --filter @repo/db db:concurrent-indexes drizzle/0123_name.sql     (DIRECT_URL; production needs CONFIRM_PRODUCTION)
 *
 * An interrupted concurrent build leaves an INVALID index that IF NOT EXISTS would skip forever: it is dropped and
 * rebuilt, and every index is checked valid at the end.
 */
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Name the migration file: db:concurrent-indexes drizzle/0123_name.sql');
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL is not set');
  assertNotProduction(url);
  const indexes = concurrentIndexes(readFileSync(resolve(process.cwd(), file), 'utf8'));
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql`set statement_timeout = 0`;
    for (const ix of indexes) {
      const valid = async () => (await sql<{ ok: boolean }[]>`select i.indisvalid as ok from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = ${ix.name} and c.relnamespace = 'public'::regnamespace`)[0]?.ok;
      if ((await valid()) === false) {
        console.log(`${ix.name}: invalid (an earlier build was interrupted), dropping it`);
        await sql.unsafe(`drop index concurrently if exists "${ix.name}"`);
      }
      const started = Date.now();
      await sql.unsafe(ix.sql);
      if ((await valid()) !== true) throw new Error(`${ix.name} is not valid after the build`);
      console.log(`${ix.name}: built in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    console.log(`${indexes.length} index(es) ready; now run db:migrate`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
